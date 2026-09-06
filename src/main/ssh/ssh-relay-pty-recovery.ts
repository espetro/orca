/* oxlint-disable max-lines -- Why: owns the SSH PTY reattach/recovery state machine end to end; splitting further would scatter one loss-of-contact protocol across files. */
import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import type { SshPtyConsumerOwnerState } from './ssh-pty-consumer-session'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { Store } from '../persistence'
import type { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import type { SshPtyProvider } from '../providers/ssh-pty-provider'
import type { SshPtyAttachResult } from '../providers/ssh-pty-session-reattach'
import type { SshPtyDataCallback, SshPtyExitCallback } from '../providers/ssh-pty-provider-contract'
import type { SshPtyRecoveryActivationLease } from '../providers/ssh-pty-notification-routing'
import { isSshPtyIdentityMismatchError, isSshPtyNotFoundError } from '../providers/ssh-pty-errors'
import { toAppSshPtyId, toRelaySshPtyId } from '../providers/ssh-pty-id'
import {
  clearProviderPtyState,
  deletePtyOwnership,
  getPtyIdsForConnection,
  getSshPtyProvider,
  isCurrentPtyExit,
  restorePtyIncarnation,
  setPtyOwnership
} from '../ipc/pty'
import {
  acceptSshPtyOutputData,
  acceptSshPtyOutputExit,
  applySshPtySourceCancellationProof,
  applySshPtySourceRecoveryCancellationProof,
  beginSshPtyOutputGenerationMigration,
  closeSshPtyOutputGeneration,
  getSshPtyAcceptedSourceCheckpoints
} from '../ipc/ssh-pty-output-intake-registry'
import { replayPendingSshPtyKills } from './ssh-pending-pty-kill-replay'
import { getSshPtyConsumerRecovery } from './ssh-pty-consumer-recovery'
import { classifySshPtyFrameRejection, SshPtyFrameRejectionLog } from './ssh-pty-frame-rejection'
import { SshPtyRecoveryRetentionBudget } from './ssh-pty-recovery-retention-budget'
import { SshPtyRetiredSourceDeliveries } from './ssh-pty-retired-source-deliveries'
import { SshPtyTargetedReattachQueue } from './ssh-pty-targeted-reattach-queue'
import {
  findTerminalTabIdForLeaf,
  hasHostAuthoritativeTerminalMembership
} from '../runtime/workspace-session-terminal-membership-authority'
import { toSshExecutionHostId } from '../../shared/execution-host'
import { isTerminalLeafId, makePaneKey } from '../../shared/stable-pane-id'
import { isValidTerminalTabId } from '../../shared/terminal-tab-id'
import type {
  PtySourceRecoveryComplete,
  PtySourceRecoveryPending,
  PtySourceRecoveryRequest
} from '../../shared/pty-source-recovery-contract'

// Verdict vocabulary for loss of contact (docs/reference/ssh-execution-boundary.md): loss of contact
// is never evidence of process death. Outcomes here are `live` (attach confirmed), `exited` (exit
// observed and reconciled), or `unverifiable` (ownership deliberately retained; see the sweep docs
// in ssh-relay-session).

type SshPtyExitPayload = Parameters<SshPtyExitCallback>[0]
type SshPtyDataPayload = Parameters<SshPtyDataCallback>[0]
type SshPtyLease = ReturnType<Store['getSshRemotePtyLeases']>[number]
const SSH_PTY_REATTACH_MAX_CONCURRENCY = 8
const SSH_PTY_REATTACH_ATTEMPT_TIMEOUT_MS = 10_000
const SSH_PTY_REATTACH_RETRY_MIN_DELAY_MS = 50
const SSH_PTY_REATTACH_RETRY_JITTER_MS = 200
const SSH_REJECTED_PTY_RECOVERY_MAX_ATTEMPTS = 2
// Why a second ceiling: the consecutive budget resets whenever a reattach succeeds, so a PTY that
// alternates recovered and rejected frames would otherwise reattach forever — each one costs a
// store read, an attach round trip and a store write.
const SSH_REJECTED_PTY_RECOVERY_MAX_GENERATION_ATTEMPTS = 12
const SSH_REJECTED_PTY_RECOVERY_RETRY_DELAY_MS = 150
const SSH_SOURCE_RECOVERY_CANCELLATION_FAILED = 'ssh_source_recovery_cancellation_failed'

type PendingPtyReattach = {
  mux: SshChannelMultiplexer
  providerGeneration: number
  retentionKey: string
  exits: SshPtyExitPayload[]
  queuedData: SshPtyDataPayload[]
  recoveryData: SshPtyDataPayload[]
  liveData: SshPtyDataPayload[]
  recovery?: PtySourceRecoveryPending
  recoveryComplete?: PtySourceRecoveryComplete
  nextRecoverySourceSu?: number
  highestRecoverySourceEndSu?: number
  replacementDeliveryToken?: string
  restoreRequired?: string
  recoveryWaiters: Set<() => void>
  livePassthrough: boolean
  activated: boolean
}

export type ExpectedPtyIdentity = { paneKey?: string; tabId?: string }
export type TargetedDeliveryRecovery = 'confirm-existing' | 'fresh-activation'

function expectedIdentityForLease(lease: {
  tabId?: string
  leafId?: string
}): ExpectedPtyIdentity | null {
  if (typeof lease.tabId !== 'string' || lease.tabId.length === 0) {
    return null
  }
  const paneKey =
    isValidTerminalTabId(lease.tabId) &&
    typeof lease.leafId === 'string' &&
    isTerminalLeafId(lease.leafId)
      ? makePaneKey(lease.tabId, lease.leafId)
      : undefined
  return {
    ...(paneKey ? { paneKey } : {}),
    tabId: lease.tabId
  }
}

function parseRecoveryComplete(params: Record<string, unknown>): PtySourceRecoveryComplete | null {
  if (
    typeof params.id !== 'string' ||
    typeof params.deliveryToken !== 'string' ||
    params.deliveryToken.length === 0 ||
    typeof params.ptyIncarnation !== 'string' ||
    params.ptyIncarnation.length === 0 ||
    !positiveSafeInteger(params.clientGeneration) ||
    !positiveSafeInteger(params.ownerGeneration) ||
    !nonNegativeSafeInteger(params.checkpointSourceEndSu) ||
    !nonNegativeSafeInteger(params.recoveryEndSu) ||
    Number(params.recoveryEndSu) < Number(params.checkpointSourceEndSu)
  ) {
    return null
  }
  return Object.freeze({
    id: params.id,
    deliveryToken: params.deliveryToken,
    ptyIncarnation: params.ptyIncarnation,
    clientGeneration: Number(params.clientGeneration),
    ownerGeneration: Number(params.ownerGeneration),
    checkpointSourceEndSu: Number(params.checkpointSourceEndSu),
    recoveryEndSu: Number(params.recoveryEndSu)
  })
}

function positiveSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function nonNegativeSafeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function sourceRecoveryCancellationError(cause: unknown): Error {
  return Object.assign(new Error(SSH_SOURCE_RECOVERY_CANCELLATION_FAILED), {
    code: SSH_SOURCE_RECOVERY_CANCELLATION_FAILED,
    cause
  })
}

export function isSourceRecoveryCancellationError(error: unknown): boolean {
  return (error as { code?: unknown })?.code === SSH_SOURCE_RECOVERY_CANCELLATION_FAILED
}

export type SshRelayPtyRecoveryContext = {
  targetId: string
  store: Store
  runtime: OrcaRuntimeService | undefined
  getMainWindow: () => BrowserWindow | null
  mux: () => SshChannelMultiplexer | null
  activePtyProviderGeneration: () => number | null
  activePtyConsumerOwner: () => SshPtyConsumerOwnerState | null
}

/** Owns the SSH PTY reattach/recovery state machine for a relay session: pending reattach
 *  bookkeeping, recovery-frame quarantine/admission, source-recovery fences and targeted
 *  delivery recovery. Loss of contact is never evidence of process death — see the verdict
 *  vocabulary at the top of this file. */
export class SshRelayPtyRecovery {
  private readonly pendingPtyReattaches = new Map<string, PendingPtyReattach>()
  private readonly ptyRecoveryRetention = new SshPtyRecoveryRetentionBudget()
  private readonly sourceIdentityByRelayPtyId = new Map<
    string,
    Readonly<{
      deliveryToken: string
      clientGeneration: number
      ownerGeneration: number
      ptyIncarnation: string
      nextSourceSu?: number
    }>
  >()
  private readonly retiredSourceDeliveries = new SshPtyRetiredSourceDeliveries()
  private readonly rejectedPtyRecoveryAttempts = new Map<
    string,
    {
      providerGeneration: number
      attempts: number
      generationAttempts: number
      reported: boolean
    }
  >()
  private readonly rejectedPtyRecoveryRetries = new Set<ReturnType<typeof setTimeout>>()
  private readonly rejectedPtyReattaches = new SshPtyTargetedReattachQueue(
    SSH_PTY_REATTACH_MAX_CONCURRENCY
  )
  private readonly ptyFrameRejectionLog = new SshPtyFrameRejectionLog()
  private ptyRecoveryNotificationCleanups: (() => void)[] = []

  constructor(private readonly ctx: SshRelayPtyRecoveryContext) {}

  acceptPtyData(payload: SshPtyDataPayload): Promise<unknown> {
    const consumerOwner = this.ctx.activePtyConsumerOwner()
    const offeredSource = payload.source
    if (
      offeredSource &&
      this.retiredSourceDeliveries.has(payload.providerGeneration, offeredSource)
    ) {
      return Promise.resolve()
    }
    const rejection = classifySshPtyFrameRejection(payload, consumerOwner)
    if (rejection) {
      if (offeredSource) {
        this.retiredSourceDeliveries.retire(payload.providerGeneration, offeredSource)
      }
      this.ptyFrameRejectionLog.record(payload, consumerOwner, rejection)
      if (rejection.action === 'retire-and-reattach-delivery') {
        this.recoverRejectedPtyDelivery(payload, offeredSource)
      }
      return Promise.resolve()
    }
    const source = consumerOwner?.outputFlowControl ? offeredSource : undefined
    if (source && consumerOwner) {
      const current = this.sourceIdentityByRelayPtyId.get(source.relayPtyId)
      if (
        source.sourceEndSu <= source.sourceStartSu ||
        (current &&
          (current.deliveryToken !== source.deliveryToken ||
            current.clientGeneration !== source.clientGeneration ||
            current.ownerGeneration !== source.ownerGeneration ||
            current.ptyIncarnation !== payload.ptyIncarnation ||
            (current.nextSourceSu !== undefined && current.nextSourceSu !== source.sourceStartSu)))
      ) {
        const rejection = {
          reason: 'source-range-invalid',
          action: 'retire-and-reattach-delivery'
        } as const
        this.retiredSourceDeliveries.retire(payload.providerGeneration, source)
        this.ptyFrameRejectionLog.record(payload, consumerOwner, rejection)
        this.recoverRejectedPtyDelivery(payload, source)
        return Promise.resolve()
      }
      this.sourceIdentityByRelayPtyId.set(source.relayPtyId, {
        deliveryToken: source.deliveryToken,
        clientGeneration: source.clientGeneration,
        ownerGeneration: source.ownerGeneration,
        ptyIncarnation: payload.ptyIncarnation,
        nextSourceSu: source.sourceEndSu
      })
    }
    const rawLength = payload.sequenceChars ?? payload.data.length
    return acceptSshPtyOutputData({
      id: payload.id,
      data: payload.data,
      providerGeneration: payload.providerGeneration,
      ptyIncarnation: payload.ptyIncarnation,
      rawLength,
      transformed: payload.transformed === true,
      ...(typeof payload.seq === 'number' ? { sequence: payload.seq } : {}),
      ...(source ? { source } : {})
    })
  }

  recoverRejectedPtyDelivery(
    payload: SshPtyDataPayload,
    source: SshPtyDataPayload['source']
  ): void {
    const mux = this.ctx.mux()
    const providerGeneration = this.ctx.activePtyProviderGeneration()
    let relayPtyId: string
    try {
      relayPtyId = source?.relayPtyId ?? toRelaySshPtyId(this.ctx.targetId, payload.id)
    } catch {
      return
    }
    const appPtyId = toAppSshPtyId(this.ctx.targetId, relayPtyId)
    if (
      payload.id !== appPtyId ||
      !mux ||
      mux.isDisposed() ||
      providerGeneration !== payload.providerGeneration ||
      this.pendingPtyReattaches.has(appPtyId) ||
      this.rejectedPtyReattaches.has(appPtyId)
    ) {
      return
    }
    if (payload.rejectedSourceRecovery === 'reconnect-channel') {
      console.warn(
        `[ssh-relay-session] PTY ${relayPtyId} delivery identity could not be retired safely for ${this.ctx.targetId}; dropping the relay channel to reconnect`
      )
      mux.dispose('connection_lost')
      return
    }
    const previous = this.rejectedPtyRecoveryAttempts.get(appPtyId)
    const attempt =
      previous?.providerGeneration === providerGeneration
        ? previous
        : { providerGeneration, attempts: 0, generationAttempts: 0, reported: false }
    if (
      attempt.attempts >= SSH_REJECTED_PTY_RECOVERY_MAX_ATTEMPTS ||
      attempt.generationAttempts >= SSH_REJECTED_PTY_RECOVERY_MAX_GENERATION_ATTEMPTS
    ) {
      if (!attempt.reported) {
        attempt.reported = true
        console.warn(
          `[ssh-relay-session] PTY ${relayPtyId} delivery recovery exhausted for ${this.ctx.targetId}; dropping the relay channel to reconnect`
        )
        // Why a channel drop and not a terminal relay error: a terminal error clears the reconnect
        // backoff, rotates provider authority (aborting every in-flight fs and git request on the
        // target) and parks the target in a manual-recovery state — over one PTY's delivery. Losing
        // the channel is the recoverable escalation, and it is what this path did before targeted
        // recovery existed.
        mux.dispose('connection_lost')
      }
      return
    }
    attempt.attempts++
    attempt.generationAttempts++
    this.rejectedPtyRecoveryAttempts.set(appPtyId, attempt)
    void this.rejectedPtyReattaches
      .run(appPtyId, () =>
        this.reattachRejectedPty(
          relayPtyId,
          mux,
          providerGeneration,
          payload.rejectedSourceRecovery === 'fresh-activation'
            ? 'fresh-activation'
            : 'confirm-existing'
        )
      )
      .then(
        (recovered) => {
          if (recovered) {
            // Why only a completed reattach clears this: an accepted frame proves nothing about the
            // delivery that was rejected, and resetting on one lets a flapping PTY reattach forever.
            attempt.attempts = 0
            return
          }
          this.retryRejectedPtyDelivery(payload, source, appPtyId)
        },
        (error: unknown) => {
          console.warn(`[ssh-relay-session] PTY ${relayPtyId} targeted delivery recovery failed`, {
            providerGeneration,
            error: error instanceof Error ? error.message : String(error)
          })
          this.retryRejectedPtyDelivery(payload, source, appPtyId)
        }
      )
  }

  // Why liveness is checked before retrying: reattachKnownPty resolves without claiming the lease
  // when the PTY exited mid-attach, which is indistinguishable from a failed reattach at the call
  // site. Retrying that race twice would drop the relay channel over an ordinary PTY exit.
  private retryRejectedPtyDelivery(
    payload: SshPtyDataPayload,
    source: SshPtyDataPayload['source'],
    appPtyId: string
  ): void {
    const ptyProvider = getSshPtyProvider(this.ctx.targetId) as SshPtyProvider | undefined
    if (!ptyProvider || typeof ptyProvider.hasPty !== 'function' || !ptyProvider.hasPty(appPtyId)) {
      this.rejectedPtyRecoveryAttempts.delete(appPtyId)
      return
    }
    const timer = setTimeout(() => {
      this.rejectedPtyRecoveryRetries.delete(timer)
      this.recoverRejectedPtyDelivery(payload, source)
    }, SSH_REJECTED_PTY_RECOVERY_RETRY_DELAY_MS)
    timer.unref?.()
    this.rejectedPtyRecoveryRetries.add(timer)
  }

  private async reattachRejectedPty(
    relayPtyId: string,
    mux: SshChannelMultiplexer,
    providerGeneration: number,
    targetedDeliveryRecovery: TargetedDeliveryRecovery
  ): Promise<boolean> {
    const shouldContinue = () =>
      this.ctx.mux() === mux &&
      !mux.isDisposed() &&
      this.ctx.activePtyProviderGeneration() === providerGeneration
    const ptyProvider = getSshPtyProvider(this.ctx.targetId) as SshPtyProvider | undefined
    // Why re-checked here: this can have waited for a queue slot, and a superseded generation must
    // not pay for a lease read or an attach round trip.
    if (!ptyProvider || !shouldContinue()) {
      return false
    }
    const activeLease = this.ctx.store
      .getSshRemotePtyLeases(this.ctx.targetId)
      .find(
        (lease) =>
          lease.ptyId === relayPtyId && lease.state !== 'terminated' && lease.state !== 'expired'
      )
    const activeLeaseByPtyId = activeLease
      ? new Map<string, SshPtyLease>([[relayPtyId, activeLease]])
      : new Map<string, SshPtyLease>()
    const expectedIdentity = activeLease ? expectedIdentityForLease(activeLease) : undefined
    const attachedLeaseIds = new Set<string>()
    await this.reattachKnownPty({
      ptyProvider,
      ptyId: relayPtyId,
      activeLeaseByPtyId,
      expectedIdentityByPtyId: expectedIdentity
        ? new Map([[relayPtyId, expectedIdentity]])
        : new Map(),
      attachedLeaseIds,
      mux,
      providerGeneration,
      shouldContinue,
      targetedDeliveryRecovery
    })
    if (attachedLeaseIds.size > 0 && shouldContinue()) {
      await this.ctx.store.markSshRemotePtyLeasesAttachedAsync(
        this.ctx.targetId,
        Array.from(attachedLeaseIds)
      )
    }
    return attachedLeaseIds.has(relayPtyId)
  }

  quarantineReattachData(pending: PendingPtyReattach, payload: SshPtyDataPayload): void {
    this.observePrivateRecoveryFrame(pending, payload)
    if (pending.restoreRequired) {
      return
    }
    const sourceSu = payload.source
      ? payload.source.sourceEndSu - payload.source.sourceStartSu
      : (payload.sequenceChars ?? payload.data.length)
    if (!this.ptyRecoveryRetention.tryRetain(pending.retentionKey, payload.data, sourceSu)) {
      pending.restoreRequired = 'recoveryQuarantineCapacityExceeded'
      this.wakeRecovery(pending)
      return
    }
    this.routeQuarantinedReattachData(pending, payload)
  }

  private routeQuarantinedReattachData(
    pending: PendingPtyReattach,
    payload: SshPtyDataPayload
  ): void {
    this.observePrivateRecoveryFrame(pending, payload)
    if (!pending.recovery) {
      pending.queuedData.push(payload)
      return
    }
    if (
      pending.recoveryComplete &&
      pending.nextRecoverySourceSu === pending.recovery.recoveryEndSu
    ) {
      pending.liveData.push(payload)
      return
    }
    this.admitRecoveryData(pending, payload)
  }

  private observePrivateRecoveryFrame(
    pending: PendingPtyReattach,
    payload: SshPtyDataPayload
  ): void {
    const recovery = pending.recovery
    if (
      recovery &&
      payload.source?.deliveryToken === recovery.deliveryToken &&
      payload.source.clientGeneration === recovery.clientGeneration &&
      payload.source.ownerGeneration === recovery.ownerGeneration &&
      payload.ptyIncarnation === recovery.ptyIncarnation
    ) {
      pending.highestRecoverySourceEndSu = Math.max(
        pending.highestRecoverySourceEndSu ?? recovery.checkpointSourceEndSu,
        payload.source.sourceEndSu
      )
    }
  }

  private admitRecoveryData(pending: PendingPtyReattach, payload: SshPtyDataPayload): void {
    if (pending.restoreRequired) {
      return
    }
    const recovery = pending.recovery
    const nextSourceSu = pending.nextRecoverySourceSu
    if (
      !recovery ||
      !payload.source ||
      nextSourceSu === undefined ||
      payload.source.deliveryToken !== recovery.deliveryToken ||
      payload.source.clientGeneration !== recovery.clientGeneration ||
      payload.source.ownerGeneration !== recovery.ownerGeneration ||
      payload.source.sourceStartSu !== nextSourceSu ||
      payload.source.sourceEndSu <= payload.source.sourceStartSu ||
      payload.source.sourceEndSu > recovery.recoveryEndSu ||
      payload.ptyIncarnation !== recovery.ptyIncarnation
    ) {
      pending.restoreRequired = 'recoveryFrameIdentityMismatch'
      this.wakeRecovery(pending)
      return
    }
    pending.nextRecoverySourceSu = payload.source.sourceEndSu
    pending.recoveryData.push(payload)
  }

  pendingReattachFor(appPtyId: string): PendingPtyReattach | undefined {
    return this.pendingPtyReattaches.get(appPtyId)
  }

  sourceIdentityFor(relayPtyId: string):
    | Readonly<{
        deliveryToken: string
        clientGeneration: number
        ownerGeneration: number
        ptyIncarnation: string
        nextSourceSu?: number
      }>
    | undefined {
    return this.sourceIdentityByRelayPtyId.get(relayPtyId)
  }

  /** Teardown-half of recovery state cleanup; mirrors what teardownProviders used to clear inline. */
  disposeForTeardown(): void {
    for (const cleanup of this.ptyRecoveryNotificationCleanups) {
      cleanup()
    }
    this.ptyRecoveryNotificationCleanups = []
    this.sourceIdentityByRelayPtyId.clear()
    this.retiredSourceDeliveries.clear()
    this.rejectedPtyRecoveryAttempts.clear()
    for (const timer of this.rejectedPtyRecoveryRetries) {
      clearTimeout(timer)
    }
    this.rejectedPtyRecoveryRetries.clear()
    this.rejectedPtyReattaches.clear()
    this.ptyFrameRejectionLog.clear()
    for (const pending of this.pendingPtyReattaches.values()) {
      for (const resolve of pending.recoveryWaiters) {
        resolve()
      }
    }
    this.pendingPtyReattaches.clear()
    this.ptyRecoveryRetention.clear()
  }

  installPtyRecoveryNotifications(mux: SshChannelMultiplexer): void {
    for (const cleanup of this.ptyRecoveryNotificationCleanups) {
      cleanup()
    }
    this.ptyRecoveryNotificationCleanups = [
      mux.onNotificationByMethod('pty.recoveryComplete', (params) => {
        if (this.ctx.mux() !== mux) {
          return
        }
        const id = typeof params.id === 'string' ? toAppSshPtyId(this.ctx.targetId, params.id) : ''
        const pending = this.pendingPtyReattaches.get(id)
        if (!pending || pending.mux !== mux) {
          return
        }
        const complete = parseRecoveryComplete(params)
        if (!complete) {
          pending.restoreRequired = 'invalidRecoveryComplete'
        } else {
          pending.recoveryComplete = complete
        }
        this.wakeRecovery(pending)
      }),
      mux.onNotificationByMethod('pty.restoreRequired', (params) => {
        if (this.ctx.mux() !== mux) {
          return
        }
        const id = typeof params.id === 'string' ? toAppSshPtyId(this.ctx.targetId, params.id) : ''
        const pending = this.pendingPtyReattaches.get(id)
        if (!pending || pending.mux !== mux) {
          return
        }
        pending.restoreRequired =
          typeof params.reason === 'string' ? params.reason : 'relayRestoreRequired'
        this.wakeRecovery(pending)
      }),
      mux.onNotificationByMethod('pty.deliveryCanceled', (params) => {
        if (this.ctx.mux() !== mux) {
          return
        }
        const id = typeof params.id === 'string' ? params.id : ''
        const identity = this.sourceIdentityByRelayPtyId.get(id)
        if (
          !identity ||
          params.deliveryToken !== identity.deliveryToken ||
          params.clientGeneration !== identity.clientGeneration ||
          params.ownerGeneration !== identity.ownerGeneration ||
          params.ptyIncarnation !== identity.ptyIncarnation
        ) {
          return
        }
        const replacementDeliveryToken =
          typeof params.replacementDeliveryToken === 'string' ? params.replacementDeliveryToken : ''
        const pending = this.pendingPtyReattaches.get(toAppSshPtyId(this.ctx.targetId, id))
        if (pending?.mux === mux) {
          if (
            replacementDeliveryToken.length === 0 ||
            replacementDeliveryToken === identity.deliveryToken
          ) {
            pending.restoreRequired =
              typeof params.reason === 'string'
                ? `relayDeliveryCanceled:${params.reason}`
                : 'relayDeliveryCanceled'
            this.wakeRecovery(pending)
            return
          }
          if (
            pending.replacementDeliveryToken &&
            pending.replacementDeliveryToken !== replacementDeliveryToken
          ) {
            pending.restoreRequired = 'recoveryReplacementTokenMismatch'
            this.wakeRecovery(pending)
            return
          }
          pending.replacementDeliveryToken = replacementDeliveryToken
          return
        }
        const generation = this.ctx.activePtyProviderGeneration()
        if (
          generation !== null &&
          Number.isSafeInteger(params.sentEndSu) &&
          Number.isSafeInteger(params.creditedEndSu)
        ) {
          try {
            applySshPtySourceCancellationProof(
              {
                id: toAppSshPtyId(this.ctx.targetId, id),
                code: -1,
                providerGeneration: generation,
                ptyIncarnation: identity.ptyIncarnation
              },
              {
                sentEndSu: params.sentEndSu as number,
                creditedEndSu: params.creditedEndSu as number
              }
            )
            this.retiredSourceDeliveries.retire(generation, {
              relayPtyId: id,
              ...identity
            })
            this.sourceIdentityByRelayPtyId.delete(id)
          } catch {
            /* Invalid proof retains the active token identity. */
          }
        }
      })
    ]
  }

  wakeRecovery(pending: PendingPtyReattach): void {
    for (const resolve of pending.recoveryWaiters) {
      resolve()
    }
    pending.recoveryWaiters.clear()
  }

  async acceptPtyExit(payload: SshPtyExitPayload): Promise<void> {
    await acceptSshPtyOutputExit({
      id: payload.id,
      code: payload.code,
      providerGeneration: payload.providerGeneration,
      ptyIncarnation: payload.ptyIncarnation
    })
    if (isCurrentPtyExit(payload)) {
      this.retireExitedPty(payload, true)
    }
  }

  retireExitedPty(payload: SshPtyExitPayload, deliveryHandled = false): void {
    const relayPtyId = toRelaySshPtyId(this.ctx.targetId, payload.id)
    this.retiredSourceDeliveries.activate(relayPtyId)
    clearProviderPtyState(payload.id)
    deletePtyOwnership(payload.id)
    this.rejectedPtyRecoveryAttempts.delete(payload.id)
    getSshPtyConsumerRecovery(this.ctx.targetId)?.checkpointsByAppPtyId.delete(payload.id)
    getSshPtyConsumerRecovery(this.ctx.targetId)?.checkpointsByAppPtyId.delete(
      toRelaySshPtyId(this.ctx.targetId, payload.id)
    )
    this.ctx.store.markSshRemotePtyLease(this.ctx.targetId, relayPtyId, 'terminated')
    if (deliveryHandled) {
      return
    }
    this.ctx.runtime?.onPtyExit(payload.id, payload.code, payload.incarnationId)
    const win = this.ctx.getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('pty:exit', payload)
    }
  }

  forwardReattachReplay(appPtyId: string, data: string): void {
    if (!data) {
      return
    }
    const win = this.ctx.getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('pty:replay', { id: appPtyId, data })
    }
  }

  async reattachKnownPtys(
    mux: SshChannelMultiplexer,
    shouldContinue: () => boolean
  ): Promise<void> {
    const ptyProvider = getSshPtyProvider(this.ctx.targetId) as SshPtyProvider | undefined
    const providerGeneration = this.ctx.activePtyProviderGeneration()
    if (!ptyProvider || providerGeneration === null || this.ctx.mux() !== mux) {
      return
    }
    // Why before the lease read: a stop the user asked for and this client could not deliver is
    // replayed here, and a confirmed one tombstones its lease — so it must land before the filter
    // below decides what to reattach, or the reattach revives a PTY that is about to die.
    await replayPendingSshPtyKills({
      targetId: this.ctx.targetId,
      store: this.ctx.store,
      provider: ptyProvider,
      shouldContinue
    })
    if (!shouldContinue()) {
      return
    }
    const activeLeases = this.ctx.store
      .getSshRemotePtyLeases(this.ctx.targetId)
      .filter((lease) => lease.state !== 'terminated' && lease.state !== 'expired')
    const activeLeaseByPtyId = new Map(activeLeases.map((lease) => [lease.ptyId, lease]))
    const leasedPtyIds = activeLeases.map((lease) => lease.ptyId)
    // Why: pass pane identity so the relay can reject cross-generation id collisions; tabId falls back for pre-leafId leases.
    const expectedIdentityByPtyId = new Map(
      activeLeases
        .map((lease): [string, ExpectedPtyIdentity] | null => {
          const expected = expectedIdentityForLease(lease)
          return expected ? [lease.ptyId, expected] : null
        })
        .filter((entry): entry is [string, ExpectedPtyIdentity] => entry !== null)
    )
    const attachedLeaseIds = new Set<string>()
    // Why: after app restart ptyOwnership is empty, but durable SSH leases still describe grace-window survivors.
    const ptyIds = Array.from(
      new Set([
        ...getPtyIdsForConnection(this.ctx.targetId).map((ptyId) =>
          toRelaySshPtyId(this.ctx.targetId, ptyId)
        ),
        ...leasedPtyIds
      ])
    )
    let nextPtyIndex = 0
    const worker = async (): Promise<void> => {
      while (shouldContinue()) {
        const ptyId = ptyIds[nextPtyIndex++]
        if (ptyId === undefined) {
          return
        }
        try {
          await this.reattachKnownPty({
            ptyProvider,
            ptyId,
            activeLeaseByPtyId,
            expectedIdentityByPtyId,
            attachedLeaseIds,
            mux,
            providerGeneration,
            shouldContinue
          })
        } catch (error) {
          if (isSourceRecoveryCancellationError(error)) {
            throw error
          }
          console.warn(
            `[ssh-relay-session] PTY ${ptyId} reattach processing failed for ${this.ctx.targetId}: ${
              error instanceof Error ? error.message : String(error)
            }`
          )
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(SSH_PTY_REATTACH_MAX_CONCURRENCY, ptyIds.length) }, worker)
    )
    if (attachedLeaseIds.size > 0 && shouldContinue()) {
      await this.ctx.store.markSshRemotePtyLeasesAttachedAsync(
        this.ctx.targetId,
        Array.from(attachedLeaseIds)
      )
    }
  }

  private async reattachKnownPty(args: {
    ptyProvider: SshPtyProvider
    ptyId: string
    activeLeaseByPtyId: Map<string, SshPtyLease>
    expectedIdentityByPtyId: Map<string, ExpectedPtyIdentity>
    attachedLeaseIds: Set<string>
    mux: SshChannelMultiplexer
    providerGeneration: number
    shouldContinue: () => boolean
    targetedDeliveryRecovery?: TargetedDeliveryRecovery
  }): Promise<void> {
    const {
      ptyProvider,
      ptyId,
      activeLeaseByPtyId,
      expectedIdentityByPtyId,
      attachedLeaseIds,
      mux,
      providerGeneration,
      shouldContinue,
      targetedDeliveryRecovery
    } = args
    const appPtyId = toAppSshPtyId(this.ctx.targetId, ptyId)
    const pendingReattach: PendingPtyReattach = {
      mux,
      providerGeneration,
      retentionKey: `${providerGeneration}\0${appPtyId}\0${randomUUID()}`,
      exits: [],
      queuedData: [],
      recoveryData: [],
      liveData: [],
      recoveryWaiters: new Set(),
      livePassthrough: false,
      activated: false
    }
    this.pendingPtyReattaches.set(appPtyId, pendingReattach)
    let sourceActivationLease: SshPtyAttachResult['sourceActivationLease']
    let recoveryActivationLease: SshPtyRecoveryActivationLease | undefined
    try {
      const recoveryRequest =
        targetedDeliveryRecovery === 'fresh-activation'
          ? undefined
          : await this.sourceRecoveryRequest(appPtyId)
      const attachResult = await this.attachPtyWithRetry(
        ptyProvider,
        ptyId,
        expectedIdentityByPtyId.get(ptyId),
        recoveryRequest,
        shouldContinue
      )
      sourceActivationLease = attachResult.sourceActivationLease
      if (!shouldContinue()) {
        return
      }
      const exitDuringAttach = pendingReattach.exits.find(
        (exit) =>
          !exit.incarnationId ||
          !attachResult.incarnationId ||
          exit.incarnationId === attachResult.incarnationId
      )
      if (exitDuringAttach && !recoveryRequest) {
        if (attachResult.incarnationId) {
          restorePtyIncarnation(appPtyId, attachResult.incarnationId)
          this.ctx.runtime?.acceptPtyIncarnationForExit(appPtyId, attachResult.incarnationId)
        }
        await this.acceptPtyExit(exitDuringAttach)
        return
      }
      const existingDeliveryConfirmed =
        targetedDeliveryRecovery === 'confirm-existing' &&
        recoveryRequest?.status === 'checkpoint' &&
        !attachResult.sourceRecovery &&
        Boolean(
          attachResult.sourceActivation &&
          this.sameSourceDelivery(attachResult.sourceActivation, recoveryRequest)
        )
      if (targetedDeliveryRecovery) {
        const owner = this.ctx.activePtyConsumerOwner()
        const activation = attachResult.sourceActivation
        if (
          !owner?.outputFlowControl ||
          !activation ||
          activation.clientGeneration !== owner.clientGeneration ||
          activation.ownerGeneration !== owner.ownerGeneration
        ) {
          return
        }
      }
      if (recoveryRequest && !existingDeliveryConfirmed) {
        const recovered = await this.finishSourceRecovery(
          ptyId,
          appPtyId,
          attachResult,
          recoveryRequest,
          pendingReattach,
          shouldContinue,
          () => {
            const lease = sourceActivationLease
            if (!lease) {
              return
            }
            recoveryActivationLease = lease.transferToRecovery((payload) =>
              this.quarantineReattachData(pendingReattach, payload)
            )
            sourceActivationLease = undefined
          }
        )
        if (!recovered) {
          const recoveryExit = this.findExactPendingExit(
            pendingReattach,
            attachResult.incarnationId
          )
          if (
            recoveryExit &&
            shouldContinue() &&
            this.ownsPtyRecoveryAttempt(appPtyId, pendingReattach)
          ) {
            if (recoveryActivationLease) {
              recoveryActivationLease.retire()
              recoveryActivationLease = undefined
            } else if (sourceActivationLease) {
              const canceled = await sourceActivationLease.rollback()
              sourceActivationLease = undefined
              if (!canceled) {
                throw sourceRecoveryCancellationError(
                  new Error('ssh_source_activation_cancellation_unproven')
                )
              }
            }
            this.preparePtyIncarnationForExit(appPtyId, attachResult.incarnationId)
            await this.acceptPtyExit(recoveryExit)
          }
          return
        }
        const recoveryExit = this.findExactPendingExit(pendingReattach, attachResult.incarnationId)
        if (recoveryExit) {
          this.preparePtyIncarnationForExit(appPtyId, attachResult.incarnationId)
          pendingReattach.activated = true
          recoveryActivationLease?.commit()
          recoveryActivationLease = undefined
          await this.acceptPtyExit(recoveryExit)
          return
        }
      }
      if (!shouldContinue() || !this.ownsPtyRecoveryAttempt(appPtyId, pendingReattach)) {
        return
      }
      setPtyOwnership(appPtyId, this.ctx.targetId)
      if (attachResult.incarnationId) {
        restorePtyIncarnation(appPtyId, attachResult.incarnationId)
        this.restoreReattachedPtyRuntime(
          appPtyId,
          attachResult.incarnationId,
          activeLeaseByPtyId.get(ptyId)
        )
      }
      attachedLeaseIds.add(ptyId)
      pendingReattach.activated = true
      recoveryActivationLease?.commit()
      recoveryActivationLease = undefined
      if (targetedDeliveryRecovery) {
        if (targetedDeliveryRecovery === 'fresh-activation') {
          this.retiredSourceDeliveries.activate(ptyId)
          this.sourceIdentityByRelayPtyId.delete(ptyId)
          getSshPtyConsumerRecovery(this.ctx.targetId)?.checkpointsByAppPtyId.delete(appPtyId)
          getSshPtyConsumerRecovery(this.ctx.targetId)?.checkpointsByAppPtyId.delete(ptyId)
        }
        while (pendingReattach.queuedData.length > 0) {
          await this.acceptPtyData(pendingReattach.queuedData.shift()!)
        }
        pendingReattach.livePassthrough = true
      }
      const exitAfterActivation = pendingReattach.exits.find(
        (exit) =>
          !exit.incarnationId ||
          !attachResult.incarnationId ||
          exit.incarnationId === attachResult.incarnationId
      )
      if (exitAfterActivation) {
        await this.acceptPtyExit(exitAfterActivation)
        return
      }
      if (!recoveryRequest && !targetedDeliveryRecovery) {
        this.forwardReattachReplay(appPtyId, attachResult.replay ?? '')
      }
      sourceActivationLease?.commit()
      sourceActivationLease = undefined
    } catch (error) {
      if (isSourceRecoveryCancellationError(error)) {
        throw error
      }
      if (!shouldContinue()) {
        return
      }
      this.handlePtyReattachFailure(ptyId, appPtyId, pendingReattach, error)
    } finally {
      recoveryActivationLease?.retire()
      sourceActivationLease?.rollback()
      if (this.pendingPtyReattaches.get(appPtyId) === pendingReattach) {
        this.pendingPtyReattaches.delete(appPtyId)
      }
      this.ptyRecoveryRetention.release(pendingReattach.retentionKey)
    }
  }

  findExactPendingExit(
    pending: PendingPtyReattach,
    ptyIncarnation: string | undefined
  ): SshPtyExitPayload | undefined {
    if (!ptyIncarnation) {
      return undefined
    }
    return pending.exits.find(
      (exit) =>
        exit.providerGeneration === pending.providerGeneration &&
        exit.ptyIncarnation === ptyIncarnation
    )
  }

  private preparePtyIncarnationForExit(appPtyId: string, ptyIncarnation: string | undefined): void {
    if (!ptyIncarnation) {
      return
    }
    restorePtyIncarnation(appPtyId, ptyIncarnation)
    this.ctx.runtime?.acceptPtyIncarnationForExit(appPtyId, ptyIncarnation)
  }

  private restoreReattachedPtyRuntime(
    appPtyId: string,
    incarnationId: string,
    lease: SshPtyLease | undefined
  ): void {
    if (lease?.worktreeId && lease.tabId && lease.leafId) {
      const session = this.ctx.store.getWorkspaceSession?.()
      // The lease froze its tabId at write time; `detachTerminalPaneToTab` moves a live pane, so
      // trusting it would fence this reattach to the tab the pane LEFT and refuse a pane that
      // merely moved. Leaf is the identity, the tab is only where it currently sits.
      // SSH spawns bind panes into `ssh:<target>` while this reattach binds into `local`, so a
      // fence that consulted only one partition would read "no pane" for a pane the other holds.
      const hostSession = this.ctx.store.getWorkspaceSession?.(
        toSshExecutionHostId(this.ctx.targetId)
      )
      const tabId =
        findTerminalTabIdForLeaf(session, lease.leafId) ??
        findTerminalTabIdForLeaf(hostSession, lease.leafId) ??
        lease.tabId
      this.ctx.runtime?.registerPty(appPtyId, lease.worktreeId, this.ctx.targetId, {
        tabId,
        leafId: lease.leafId,
        incarnationId
      })
      try {
        // Absence of the pane only means "the user closed it" once the persisted membership
        // speaks for this worktree. Before that it means the renderer has not published its
        // layout yet, and refusing there drops a tab the user still has — the regression that
        // reverted this fix twice. Losing a tab is worse than keeping a duplicate, so an
        // unauthoritative session still gets the creating write.
        // Authority is read from `local` because that is the partition this write lands in — it
        // is local's absence we would be interpreting. But a pane the other partition still holds
        // is not gone, so it keeps its creating write: refusing there would strand a live pane
        // behind a binding reattach can no longer reach.
        const mayCreate =
          !hasHostAuthoritativeTerminalMembership(session, lease.worktreeId) ||
          findTerminalTabIdForLeaf(hostSession, lease.leafId) !== undefined
        const bound = this.ctx.store.persistPtyBinding({
          worktreeId: lease.worktreeId,
          tabId,
          leafId: lease.leafId,
          ptyId: appPtyId,
          incarnationId,
          ...(mayCreate ? {} : { mayCreate: false })
        })
        if (bound === false) {
          // The pane is gone for good, so this shell has no surface to reach it through. Expire
          // the lease so later reconnects stop fanning out over it — deliberately not
          // `terminated`, which would assert an exit nothing here observed, and deliberately
          // without killing the remote process.
          this.ctx.store.markSshRemotePtyLease(this.ctx.targetId, appPtyId, 'expired')
        }
      } catch (error) {
        console.error('[ssh-relay-session] Failed to persist reconnect incarnation:', error)
      }
      return
    }
    this.ctx.runtime?.onPtySpawned(appPtyId, incarnationId, { awaitsRegistration: false })
  }

  private async attachPtyWithRetry(
    ptyProvider: SshPtyProvider,
    ptyId: string,
    expectedIdentity: ExpectedPtyIdentity | undefined,
    recoveryRequest: PtySourceRecoveryRequest | undefined,
    shouldContinue: () => boolean
  ): Promise<SshPtyAttachResult> {
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!shouldContinue()) {
        throw lastError ?? new Error('PTY reattach attempt is no longer current')
      }
      try {
        return await this.attachPtyWithDeadline(
          ptyProvider,
          ptyId,
          expectedIdentity,
          recoveryRequest
        )
      } catch (error) {
        lastError = error
        if (!shouldContinue() || isSshPtyNotFoundError(error) || attempt === 1) {
          throw error
        }
        await this.waitForPtyReattachRetry()
      }
    }
    throw lastError
  }

  private async attachPtyWithDeadline(
    ptyProvider: SshPtyProvider,
    ptyId: string,
    expectedIdentity: ExpectedPtyIdentity | undefined,
    recoveryRequest: PtySourceRecoveryRequest | undefined
  ): Promise<SshPtyAttachResult> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        reject(
          new Error(`PTY reattach attempt timed out after ${SSH_PTY_REATTACH_ATTEMPT_TIMEOUT_MS}ms`)
        )
      }, SSH_PTY_REATTACH_ATTEMPT_TIMEOUT_MS)
      timer.unref?.()
    })
    try {
      const attach = expectedIdentity
        ? recoveryRequest
          ? ptyProvider.attachForReconnect(ptyId, expectedIdentity, recoveryRequest)
          : ptyProvider.attachForReconnect(ptyId, expectedIdentity)
        : recoveryRequest
          ? ptyProvider.attachForReconnect(ptyId, undefined, recoveryRequest)
          : ptyProvider.attachForReconnect(ptyId)
      const guardedAttach = attach.then((result) => {
        if (timedOut) {
          result.sourceActivationLease?.rollback()
        }
        return result
      })
      return (await Promise.race([guardedAttach, timeout])) ?? {}
    } finally {
      if (timer) {
        clearTimeout(timer)
      }
    }
  }

  private async waitForPtyReattachRetry(): Promise<void> {
    const delayMs =
      SSH_PTY_REATTACH_RETRY_MIN_DELAY_MS +
      Math.floor(Math.random() * (SSH_PTY_REATTACH_RETRY_JITTER_MS + 1))
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs)
      timer.unref?.()
    })
  }

  private handlePtyReattachFailure(
    ptyId: string,
    appPtyId: string,
    pending: PendingPtyReattach,
    error: unknown
  ): void {
    if (!isSshPtyNotFoundError(error)) {
      pending.restoreRequired = 'reattachAttemptsExhausted'
      this.wakeRecovery(pending)
      console.warn(
        `[ssh-relay-session] Leaving PTY ${ptyId} detached for ${this.ctx.targetId} after bounded reattach attempts failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      return
    }
    if (isSshPtyIdentityMismatchError(error)) {
      console.warn(
        `[ssh-relay-session] Ignoring stale PTY ${ptyId} for ${this.ctx.targetId} after relay identity mismatch: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      return
    }
    console.warn(
      `[ssh-relay-session] Dropping stale PTY ${ptyId} for ${this.ctx.targetId} after relay reattach failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    clearProviderPtyState(appPtyId)
    deletePtyOwnership(appPtyId)
    this.ctx.store.markSshRemotePtyLease(this.ctx.targetId, ptyId, 'expired')
    const win = this.ctx.getMainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('pty:exit', { id: appPtyId, code: -1 })
    }
  }

  private async sourceRecoveryRequest(
    appPtyId: string
  ): Promise<PtySourceRecoveryRequest | undefined> {
    if (!this.ctx.activePtyConsumerOwner()?.outputFlowControl) {
      return undefined
    }
    const recovery = getSshPtyConsumerRecovery(this.ctx.targetId)
    const migration = recovery?.modelMigrationsByAppPtyId.get(appPtyId)
    if (migration) {
      const outcome = await migration
      if (recovery?.modelMigrationsByAppPtyId.get(appPtyId) === migration) {
        recovery.modelMigrationsByAppPtyId.delete(appPtyId)
      }
      if (outcome.status !== 'settled') {
        return Object.freeze({ status: 'checkpointUnavailable' })
      }
    }
    const checkpoints = recovery?.checkpointsByAppPtyId
    const relayPtyId = toRelaySshPtyId(this.ctx.targetId, appPtyId)
    // Why: every checkpoint writer records app-id keys now, so the relay-id
    // lookup (and its paired delete below) is a legacy guard only.
    const checkpoint = checkpoints?.get(appPtyId) ?? checkpoints?.get(relayPtyId)
    if (!checkpoint) {
      return Object.freeze({ status: 'checkpointUnavailable' })
    }
    return Object.freeze({
      status: 'checkpoint',
      clientGeneration: checkpoint.clientGeneration,
      ownerGeneration: checkpoint.ownerGeneration,
      ptyIncarnation: checkpoint.ptyIncarnation,
      deliveryToken: checkpoint.deliveryToken,
      acceptedSourceEndSu: checkpoint.acceptedSourceEndSu
    })
  }

  beginPtyModelMigration(providerGeneration: number, closeReason: string): void {
    const recovery = getSshPtyConsumerRecovery(this.ctx.targetId)
    if (!recovery) {
      closeSshPtyOutputGeneration(providerGeneration, closeReason)
      return
    }
    for (const checkpoint of getSshPtyAcceptedSourceCheckpoints(providerGeneration)) {
      recovery.checkpointsByAppPtyId.set(checkpoint.id, checkpoint)
    }
    const migration = beginSshPtyOutputGenerationMigration(providerGeneration)
    for (const [ptyId, result] of migration.byPty) {
      const previous = recovery.modelMigrationsByAppPtyId.get(ptyId)
      const fence = previous ? previous.then(() => result) : result
      recovery.modelMigrationsByAppPtyId.set(ptyId, fence)
      void fence.then((outcome) => {
        const current = getSshPtyConsumerRecovery(this.ctx.targetId)
        if (current?.modelMigrationsByAppPtyId.get(ptyId) !== fence) {
          return
        }
        if (outcome.status === 'settled') {
          current.checkpointsByAppPtyId.set(ptyId, outcome.checkpoint)
        } else {
          current.checkpointsByAppPtyId.delete(ptyId)
          current.checkpointsByAppPtyId.delete(toRelaySshPtyId(this.ctx.targetId, ptyId))
        }
        current.modelMigrationsByAppPtyId.delete(ptyId)
      })
    }
    void migration.completion.then(() => {
      closeSshPtyOutputGeneration(providerGeneration, closeReason)
    })
  }

  private async finishSourceRecovery(
    relayPtyId: string,
    appPtyId: string,
    attachResult: SshPtyAttachResult,
    request: PtySourceRecoveryRequest,
    pending: PendingPtyReattach,
    shouldContinue: () => boolean,
    activateRecoveryQuarantine: () => void
  ): Promise<boolean> {
    const recovery = attachResult.sourceRecovery
    const pendingRecovery = recovery?.status === 'pending' ? recovery : undefined
    const owner = this.ctx.activePtyConsumerOwner()
    if (
      !owner?.outputFlowControl ||
      !pendingRecovery ||
      request.status !== 'checkpoint' ||
      pendingRecovery.clientGeneration !== owner.clientGeneration ||
      pendingRecovery.ownerGeneration !== owner.ownerGeneration ||
      pendingRecovery.ptyIncarnation !== attachResult.incarnationId ||
      pendingRecovery.ptyIncarnation !== request.ptyIncarnation ||
      pendingRecovery.checkpointSourceEndSu !== request.acceptedSourceEndSu ||
      (pending.replacementDeliveryToken !== undefined &&
        pending.replacementDeliveryToken !== pendingRecovery.deliveryToken)
    ) {
      if (!shouldContinue() || !this.ownsPtyRecoveryAttempt(appPtyId, pending)) {
        return false
      }
      await this.abandonPtySourceRecovery(relayPtyId, appPtyId, pending)
      return false
    }
    const acceptedRecovery = pendingRecovery
    pending.recovery = acceptedRecovery
    pending.nextRecoverySourceSu = acceptedRecovery.checkpointSourceEndSu
    this.retiredSourceDeliveries.activate(relayPtyId)
    this.sourceIdentityByRelayPtyId.set(relayPtyId, {
      deliveryToken: acceptedRecovery.deliveryToken,
      clientGeneration: acceptedRecovery.clientGeneration,
      ownerGeneration: acceptedRecovery.ownerGeneration,
      ptyIncarnation: acceptedRecovery.ptyIncarnation,
      nextSourceSu: acceptedRecovery.checkpointSourceEndSu
    })
    activateRecoveryQuarantine()
    for (const payload of pending.queuedData.splice(0)) {
      this.routeQuarantinedReattachData(pending, payload)
    }
    await this.waitForRecoveryFence(pending, shouldContinue)
    const exactExit = this.findExactPendingExit(pending, acceptedRecovery.ptyIncarnation)
    const complete = pending.recoveryComplete ?? (exactExit ? acceptedRecovery : undefined)
    if (
      !shouldContinue() ||
      pending.restoreRequired ||
      !complete ||
      complete.deliveryToken !== acceptedRecovery.deliveryToken ||
      complete.clientGeneration !== acceptedRecovery.clientGeneration ||
      complete.ownerGeneration !== acceptedRecovery.ownerGeneration ||
      complete.ptyIncarnation !== acceptedRecovery.ptyIncarnation ||
      complete.checkpointSourceEndSu !== acceptedRecovery.checkpointSourceEndSu ||
      complete.recoveryEndSu !== acceptedRecovery.recoveryEndSu ||
      pending.nextRecoverySourceSu !== acceptedRecovery.recoveryEndSu
    ) {
      if (!shouldContinue() || !this.ownsPtyRecoveryAttempt(appPtyId, pending)) {
        return false
      }
      await this.abandonPtySourceRecovery(relayPtyId, appPtyId, pending)
      return false
    }
    let nextLiveSourceSu = acceptedRecovery.recoveryEndSu
    for (const payload of pending.liveData) {
      if (
        !payload.source ||
        payload.source.deliveryToken !== acceptedRecovery.deliveryToken ||
        payload.source.clientGeneration !== acceptedRecovery.clientGeneration ||
        payload.source.ownerGeneration !== acceptedRecovery.ownerGeneration ||
        payload.source.sourceStartSu !== nextLiveSourceSu ||
        payload.source.sourceEndSu <= payload.source.sourceStartSu ||
        payload.ptyIncarnation !== acceptedRecovery.ptyIncarnation
      ) {
        if (!shouldContinue() || !this.ownsPtyRecoveryAttempt(appPtyId, pending)) {
          return false
        }
        await this.abandonPtySourceRecovery(relayPtyId, appPtyId, pending)
        return false
      }
      nextLiveSourceSu = payload.source.sourceEndSu
    }
    try {
      for (const payload of pending.recoveryData) {
        await this.acceptPtyData(payload)
      }
      for (const payload of pending.liveData) {
        await this.acceptPtyData(payload)
      }
      pending.livePassthrough = true
    } catch {
      if (!shouldContinue() || !this.ownsPtyRecoveryAttempt(appPtyId, pending)) {
        return false
      }
      await this.abandonPtySourceRecovery(relayPtyId, appPtyId, pending)
      return false
    }
    if (!shouldContinue() || !this.ownsPtyRecoveryAttempt(appPtyId, pending)) {
      return false
    }
    const acceptedSourceEndSu = pending.liveData.reduce(
      (endSu, payload) => Math.max(endSu, payload.source?.sourceEndSu ?? endSu),
      acceptedRecovery.recoveryEndSu
    )
    // Why: checkpoints are app-id keyed; a relay-id entry here would be shadowed
    // by a staler app-id entry on the next sourceRecoveryRequest lookup.
    getSshPtyConsumerRecovery(this.ctx.targetId)?.checkpointsByAppPtyId.set(
      appPtyId,
      Object.freeze({
        id: appPtyId,
        providerGeneration: this.ctx.activePtyProviderGeneration()!,
        clientGeneration: acceptedRecovery.clientGeneration,
        ownerGeneration: acceptedRecovery.ownerGeneration,
        ptyIncarnation: acceptedRecovery.ptyIncarnation,
        deliveryToken: acceptedRecovery.deliveryToken,
        acceptedSourceEndSu
      })
    )
    return true
  }

  private async waitForRecoveryFence(
    pending: PendingPtyReattach,
    shouldContinue: () => boolean
  ): Promise<void> {
    const deadline = Date.now() + SSH_PTY_REATTACH_ATTEMPT_TIMEOUT_MS
    while (
      shouldContinue() &&
      !pending.recoveryComplete &&
      !pending.restoreRequired &&
      !this.findExactPendingExit(pending, pending.recovery?.ptyIncarnation) &&
      Date.now() < deadline
    ) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(
          () => {
            pending.recoveryWaiters.delete(settle)
            resolve()
          },
          Math.max(1, deadline - Date.now())
        )
        timer.unref?.()
        const settle = (): void => {
          clearTimeout(timer)
          resolve()
        }
        pending.recoveryWaiters.add(settle)
      })
    }
    if (
      !pending.recoveryComplete &&
      !pending.restoreRequired &&
      !this.findExactPendingExit(pending, pending.recovery?.ptyIncarnation)
    ) {
      pending.restoreRequired = 'recoveryFenceTimeout'
    }
  }

  private async abandonPtySourceRecovery(
    relayPtyId: string,
    appPtyId: string,
    pending: PendingPtyReattach
  ): Promise<void> {
    if (!this.ownsPtyRecoveryAttempt(appPtyId, pending)) {
      return
    }
    const recovery = pending.recovery
    const { mux, providerGeneration } = pending
    if (recovery && !mux.isDisposed()) {
      const cancellationRequest = {
        id: relayPtyId,
        clientGeneration: recovery.clientGeneration,
        ownerGeneration: recovery.ownerGeneration,
        deliveryToken: recovery.deliveryToken
      }
      this.retiredSourceDeliveries.retire(providerGeneration, {
        relayPtyId,
        deliveryToken: recovery.deliveryToken,
        clientGeneration: recovery.clientGeneration,
        ownerGeneration: recovery.ownerGeneration
      })
      try {
        const result = (await mux.request('pty.cancelDelivery', cancellationRequest)) as Record<
          string,
          unknown
        >
        const highestPrivateSourceEndSu = pending.liveData.reduce(
          (endSu, payload) => Math.max(endSu, payload.source?.sourceEndSu ?? endSu),
          Math.max(
            pending.nextRecoverySourceSu ?? recovery.checkpointSourceEndSu,
            pending.highestRecoverySourceEndSu ?? recovery.checkpointSourceEndSu
          )
        )
        if (
          result.canceled !== true ||
          !Number.isSafeInteger(result.sentEndSu) ||
          (result.sentEndSu as number) < highestPrivateSourceEndSu ||
          !Number.isSafeInteger(result.creditedEndSu) ||
          result.creditedEndSu !== recovery.checkpointSourceEndSu ||
          (result.creditedEndSu as number) > (result.sentEndSu as number)
        ) {
          throw new Error('ssh_source_cancellation_proof_invalid')
        }
        if (!this.ownsPtyRecoveryAttempt(appPtyId, pending)) {
          return
        }
        const identity = this.sourceIdentityByRelayPtyId.get(relayPtyId)
        if (identity && !this.sameSourceDelivery(identity, recovery)) {
          return
        }
        if (identity) {
          const applied = applySshPtySourceRecoveryCancellationProof(
            {
              id: appPtyId,
              code: -1,
              providerGeneration,
              ptyIncarnation: recovery.ptyIncarnation
            },
            {
              sentEndSu: result.sentEndSu as number,
              creditedEndSu: result.creditedEndSu as number
            }
          )
          if (!applied) {
            throw new Error('ssh_source_cancellation_proof_rejected')
          }
        }
      } catch (error) {
        if (!this.ownsPtyRecoveryAttempt(appPtyId, pending)) {
          return
        }
        console.warn(
          `[ssh-relay-session] Failed to cancel replacement delivery for ${relayPtyId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
        throw sourceRecoveryCancellationError(error)
      }
    }
    if (!this.ownsPtyRecoveryAttempt(appPtyId, pending)) {
      return
    }
    const identity = this.sourceIdentityByRelayPtyId.get(relayPtyId)
    if (!identity || !recovery || this.sameSourceDelivery(identity, recovery)) {
      this.sourceIdentityByRelayPtyId.delete(relayPtyId)
    }
    getSshPtyConsumerRecovery(this.ctx.targetId)?.checkpointsByAppPtyId.delete(appPtyId)
    getSshPtyConsumerRecovery(this.ctx.targetId)?.checkpointsByAppPtyId.delete(relayPtyId)
    this.ctx.store.markSshRemotePtyLease(this.ctx.targetId, relayPtyId, 'detached')
  }

  ownsPtyRecoveryAttempt(appPtyId: string, pending: PendingPtyReattach): boolean {
    return (
      this.pendingPtyReattaches.get(appPtyId) === pending &&
      this.ctx.mux() === pending.mux &&
      this.ctx.activePtyProviderGeneration() === pending.providerGeneration &&
      !pending.mux.isDisposed()
    )
  }

  sameSourceDelivery(
    left: Readonly<{
      deliveryToken: string
      clientGeneration: number
      ownerGeneration: number
      ptyIncarnation: string
    }>,
    right: Readonly<{
      deliveryToken: string
      clientGeneration: number
      ownerGeneration: number
      ptyIncarnation: string
    }>
  ): boolean {
    return (
      left.deliveryToken === right.deliveryToken &&
      left.clientGeneration === right.clientGeneration &&
      left.ownerGeneration === right.ownerGeneration &&
      left.ptyIncarnation === right.ptyIncarnation
    )
  }
}
