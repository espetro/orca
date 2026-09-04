import { createHash } from 'node:crypto'
import type { OrcaRuntimeService } from './orca-runtime'
import type {
  OrchestrationCompatibilityEvidence,
  OrchestrationCompatibilityHostStamp
} from '../../shared/orchestration-compatibility-evidence'
import type {
  OrchestrationCompatibilityTerminalAuthority,
  OrchestrationCompatibilityCallerAuthority
} from './orca-runtime'
import { syncFederatedDispatch } from './orchestration/federation-sync'
import {
  clearFederationAckCheckpoints,
  releaseFederationAckCheckpoint
} from './orchestration/federation-ack-checkpoints'

export function syncOrchestrationFederatedDispatch(
  runtime: OrcaRuntimeService,
  dispatchId: string
): Promise<void> {
  const db = runtime.getOrchestrationDb()
  const current = runtime['orchestrationFederationSyncs'].get(dispatchId)
  if (current?.db === db) {
    return current.promise
  }
  const sync = syncFederatedDispatch(runtime, dispatchId)
    .then(() => {
      if (runtime['orchestrationFederationSyncs'].get(dispatchId)?.promise === sync) {
        runtime['orchestrationFederationWarnings'].delete(dispatchId)
      }
    })
    .catch((error: unknown) => {
      if (
        runtime['orchestrationFederationSyncs'].get(dispatchId)?.promise === sync &&
        !runtime['orchestrationFederationWarnings'].has(dispatchId)
      ) {
        console.warn(`[orchestration] Federation sync failed for ${dispatchId}:`, error)
        runtime['orchestrationFederationWarnings'].add(dispatchId)
      }
      throw error
    })
    .finally(() => {
      if (runtime['orchestrationFederationSyncs'].get(dispatchId)?.promise !== sync) {
        return
      }
      runtime['orchestrationFederationSyncs'].delete(dispatchId)
      if (!db.isFederatedDispatchRelayEligible(dispatchId)) {
        releaseFederationAckCheckpoint(runtime, dispatchId)
      }
    })
  runtime['orchestrationFederationSyncs'].set(dispatchId, { db, promise: sync })
  return sync
}

export async function syncOrchestrationFederatedDispatchAfterCurrent(
  runtime: OrcaRuntimeService,
  dispatchId: string
): Promise<void> {
  const db = runtime.getOrchestrationDb()
  const current = runtime['orchestrationFederationSyncs'].get(dispatchId)
  if (current?.db === db) {
    await current.promise.catch(() => undefined)
  }
  await syncOrchestrationFederatedDispatch(runtime, dispatchId)
}

export function ensureOrchestrationFederationRelay(
  runtime: OrcaRuntimeService,
  runId?: string
): void {
  if (!runtime['orchestrationEnvironmentTransport']) {
    return
  }
  for (const dispatch of runtime.getOrchestrationDb().listActiveFederatedDispatches(runId)) {
    if (runtime['orchestrationFederationTimers'].has(dispatch.dispatch_id)) {
      continue
    }
    const tick = () => {
      if (!runtime.getOrchestrationDb().isFederatedDispatchRelayEligible(dispatch.dispatch_id)) {
        const activeTimer = runtime['orchestrationFederationTimers'].get(dispatch.dispatch_id)
        if (activeTimer) {
          clearInterval(activeTimer)
        }
        runtime['orchestrationFederationTimers'].delete(dispatch.dispatch_id)
        runtime['orchestrationFederationWarnings'].delete(dispatch.dispatch_id)
        return
      }
      void syncOrchestrationFederatedDispatch(runtime, dispatch.dispatch_id).catch(() => undefined)
    }
    const timer = setInterval(tick, 1_000)
    timer.unref?.()
    runtime['orchestrationFederationTimers'].set(dispatch.dispatch_id, timer)
    tick()
  }
  ensureTerminalHistoryRecovery(runtime)
}

function ensureTerminalHistoryRecovery(runtime: OrcaRuntimeService): void {
  if (
    runtime['orchestrationTerminalHistoryRecoveryTimer'] ||
    runtime['orchestrationTerminalHistoryRecoveryInFlight']
  ) {
    return
  }
  const generation = runtime['orchestrationFederationRelayGeneration']
  const recovery = recoverNextTerminalHistoryAcknowledgment(runtime, generation).catch((error) => {
    console.warn('[orchestration] terminal federation acknowledgment recovery failed', error)
  })
  runtime['orchestrationTerminalHistoryRecoveryInFlight'] = recovery
  void recovery.finally(() => {
    if (runtime['orchestrationTerminalHistoryRecoveryInFlight'] === recovery) {
      runtime['orchestrationTerminalHistoryRecoveryInFlight'] = null
    }
  })
}

async function recoverNextTerminalHistoryAcknowledgment(
  runtime: OrcaRuntimeService,
  generation: number
): Promise<void> {
  const db = runtime.getOrchestrationDb()
  let historical = db.findNextTerminalFederatedDispatchPendingAcknowledgment(
    runtime['orchestrationTerminalRecoveryRowId']
  )
  if (!historical && runtime['orchestrationTerminalRecoveryRowId'] > 0) {
    runtime['orchestrationTerminalRecoveryRowId'] = 0
    historical = db.findNextTerminalFederatedDispatchPendingAcknowledgment(0)
  }
  if (!historical) {
    return
  }
  runtime['orchestrationTerminalRecoveryRowId'] = historical.rowId
  await syncOrchestrationFederatedDispatch(runtime, historical.dispatchId).catch(() => undefined)
  if (generation !== runtime['orchestrationFederationRelayGeneration']) {
    return
  }
  runtime['orchestrationTerminalHistoryRecoveryTimer'] = setTimeout(() => {
    runtime['orchestrationTerminalHistoryRecoveryTimer'] = null
    ensureTerminalHistoryRecovery(runtime)
  }, 1_000)
  runtime['orchestrationTerminalHistoryRecoveryTimer'].unref?.()
}

export function stopOrchestrationFederationRelay(runtime: OrcaRuntimeService): void {
  runtime['orchestrationFederationRelayGeneration'] += 1
  for (const timer of runtime['orchestrationFederationTimers'].values()) {
    clearInterval(timer)
  }
  runtime['orchestrationFederationTimers'].clear()
  if (runtime['orchestrationTerminalHistoryRecoveryTimer']) {
    clearTimeout(runtime['orchestrationTerminalHistoryRecoveryTimer'])
    runtime['orchestrationTerminalHistoryRecoveryTimer'] = null
  }
  runtime['orchestrationTerminalHistoryRecoveryInFlight'] = null
  runtime['orchestrationTerminalRecoveryRowId'] = 0
  runtime['orchestrationFederationWarnings'].clear()
  runtime['orchestrationFederationSyncs'].clear()
  clearFederationAckCheckpoints(runtime)
}

export function verifyOrchestrationCompatibilityCaller(
  runtime: OrcaRuntimeService,
  evidence: OrchestrationCompatibilityEvidence | null | undefined,
  options?: { currentRuntimeLaunchSufficient?: boolean }
): OrchestrationCompatibilityCallerAuthority | null {
  const terminalHandle =
    typeof evidence?.terminalHandle === 'string' ? evidence.terminalHandle.trim() : ''
  const claimedPaneKey = typeof evidence?.paneKey === 'string' ? evidence.paneKey.trim() : ''
  const launchToken = typeof evidence?.launchToken === 'string' ? evidence.launchToken.trim() : ''
  const host = evidence?.host
  if (!terminalHandle || !claimedPaneKey || !launchToken) {
    return null
  }
  const terminal = runtime.getOrchestrationDispatchAuthority(terminalHandle)
  if (
    !terminal?.processIncarnation ||
    !terminal.paneKey ||
    !orchestrationCompatibilityHostMatches(runtime, terminal.hostScope, host)
  ) {
    return null
  }
  const launchTokenHash = createHash('sha256').update(launchToken).digest('hex')
  let terminalProvenance: 'current_runtime' | 'restored'
  if (terminal.launchTokenHash) {
    if (launchTokenHash !== terminal.launchTokenHash) {
      return null
    }
    terminalProvenance = 'current_runtime'
  } else {
    const receipt = runtime['restoredOrchestrationAuthorityByPtyId'].get(terminal.ptyId)
    if (
      !receipt ||
      receipt.ptyId !== terminal.ptyId ||
      receipt.worktreeId !== terminal.worktreeId ||
      receipt.terminalHandle !== terminal.terminalHandle ||
      receipt.paneKey !== terminal.paneKey ||
      receipt.processIncarnation !== terminal.processIncarnation ||
      !orchestrationCompatibilityHostScopesEqual(receipt.hostScope, terminal.hostScope)
    ) {
      return null
    }
    terminalProvenance = 'restored'
  }
  if (
    options?.currentRuntimeLaunchSufficient &&
    terminalProvenance === 'current_runtime' &&
    claimedPaneKey === terminal.paneKey
  ) {
    // Why: the checks above bind a fresh launch to its live PTY, host, and
    // launch secret. Only an exact live-pane match may skip hook attestation.
    return freezeOrchestrationCompatibilityCallerAuthority(
      terminal,
      terminal.processIncarnation,
      claimedPaneKey,
      terminalHandle,
      launchTokenHash
    )
  }
  const attestation = runtime['attestAgentHookCompatibilityAuthorityFn']?.({
    paneKey: claimedPaneKey,
    launchTokenHash,
    connectionId: terminal.hostScope.kind === 'ssh' ? terminal.hostScope.targetId : null,
    terminalProvenance
  })
  if (!attestation || attestation.paneKey !== terminal.paneKey) {
    return null
  }
  return freezeOrchestrationCompatibilityCallerAuthority(
    terminal,
    terminal.processIncarnation,
    attestation.paneKey,
    terminalHandle,
    launchTokenHash
  )
}

function freezeOrchestrationCompatibilityCallerAuthority(
  terminal: OrchestrationCompatibilityTerminalAuthority,
  processIncarnation: string,
  paneKey: string,
  terminalHandle: string,
  launchTokenHash: string
): OrchestrationCompatibilityCallerAuthority {
  return Object.freeze({
    hostScope: Object.freeze({ ...terminal.hostScope }),
    paneKey,
    terminalHandle,
    processIncarnation,
    launchTokenHash
  })
}

function orchestrationCompatibilityHostMatches(
  runtime: OrcaRuntimeService,
  hostScope: OrchestrationCompatibilityTerminalAuthority['hostScope'],
  host: OrchestrationCompatibilityHostStamp | undefined
): boolean {
  if (hostScope.kind === 'local') {
    return host === undefined
  }
  if (hostScope.kind === 'wsl') {
    return (
      host?.kind === 'wsl' && host.hostId === hostScope.hostId && host.distro === hostScope.distro
    )
  }
  if (host?.kind !== 'ssh' || host.targetId !== hostScope.targetId) {
    return false
  }
  const authority = runtime['orchestrationCompatibilitySshAttachments'].get(host.attachmentId)
  return (
    authority?.targetId === host.targetId &&
    authority.connectionIncarnation === host.connectionIncarnation
  )
}

function orchestrationCompatibilityHostScopesEqual(
  left: OrchestrationCompatibilityTerminalAuthority['hostScope'],
  right: OrchestrationCompatibilityTerminalAuthority['hostScope']
): boolean {
  if (left.kind !== right.kind) {
    return false
  }
  if (left.kind === 'local' && right.kind === 'local') {
    return left.hostId === right.hostId
  }
  if (left.kind === 'wsl' && right.kind === 'wsl') {
    return left.hostId === right.hostId && left.distro === right.distro
  }
  return left.kind === 'ssh' && right.kind === 'ssh' && left.targetId === right.targetId
}
