import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { TuiAgent } from '../../shared/agent-types'

// Constants used by liveness verdict tracking
const PROVEN_ABSENT_LEAF_PTY_TTL_MS = 15_000
const MAX_TRACKED_PTY_LIVENESS_VERDICTS = 256

// Simplified interface type for dependency injection to extracted functions
export interface OrcaRuntimeLivenessVerdictApi {
  readonly earlyExitedPtyIncarnations: Map<string, PtyIncarnationId | null>
  readonly pendingPtyRegistrationIncarnations: Map<string, PtyIncarnationId | null>
  readonly stopRequestedPtyIds: Set<string>
  readonly provenAbsentLeafPtyVerdicts: Map<string, number>
  readonly leafPtyAbsenceProbes: Map<string, Promise<boolean>>
  readonly ptyController?: { probePtyLiveness?: (ptyId: string) => Promise<boolean> }

  controllerKnowsPtyIsLive(ptyId: string): boolean
  forgetPtyLivenessVerdict(ptyId: string, observedNoLaterThan?: number): void
  getOrCreatePtyWorktreeRecord(ptyId: string): unknown
  getLeavesForPty(ptyId: string): unknown[]
  adoptPreAllocatedHandle(leaf: unknown): void
  recordPtyWorktree(
    ptyId: string,
    worktreeId: string,
    opts: Record<string, unknown>
  ): unknown
  ensurePtyBackedMobileSurfaceForRendererTab(worktreeId: string, tabId: string): void
  readonly graphStatus: string
  readonly spawnPublishedPtys: Set<string>
  readonly pendingMobileTerminalCreatesByKey: Map<string, unknown>
  readonly ptysById: Map<string, any>
  readonly handleByPtyId: Map<string, unknown>
  leafExistsForPty(ptyId: string): boolean
}

export function isLeafPtyProvenAbsent(
  ptyId: string,
  runtime: OrcaRuntimeLivenessVerdictApi
): Promise<boolean> {
  if (runtime.controllerKnowsPtyIsLive(ptyId)) {
    runtime.provenAbsentLeafPtyVerdicts.delete(ptyId)
    return Promise.resolve(false)
  }
  const verdictAt = runtime.provenAbsentLeafPtyVerdicts.get(ptyId)
  if (verdictAt !== undefined) {
    if (Date.now() - verdictAt < PROVEN_ABSENT_LEAF_PTY_TTL_MS) {
      return Promise.resolve(true)
    }
    runtime.provenAbsentLeafPtyVerdicts.delete(ptyId)
  }
  const probeLiveness = runtime.ptyController?.probePtyLiveness?.bind(runtime.ptyController)
  if (!probeLiveness) {
    return Promise.resolve(false)
  }
  const inFlight = runtime.leafPtyAbsenceProbes.get(ptyId)
  if (inFlight) {
    return inFlight
  }
  const probe = (async () => {
    try {
      if ((await probeLiveness(ptyId)) !== false) {
        return false
      }
      runtime.provenAbsentLeafPtyVerdicts.set(ptyId, Date.now())
      return true
    } catch {
      return false
    } finally {
      runtime.leafPtyAbsenceProbes.delete(ptyId)
    }
  })()
  runtime.leafPtyAbsenceProbes.set(ptyId, probe)
  return probe
}

export function isPtyStopRequested(ptyId: string, runtime: OrcaRuntimeLivenessVerdictApi): boolean {
  return runtime.stopRequestedPtyIds.has(ptyId)
}

export function markPtyStopRequested(ptyId: string, runtime: OrcaRuntimeLivenessVerdictApi): void {
  runtime.stopRequestedPtyIds.add(ptyId)
}

export function assertPtyDidNotExitBeforeRegistration(
  ptyId: string,
  candidateIncarnation: PtyIncarnationId | undefined,
  runtime: OrcaRuntimeLivenessVerdictApi
): void {
  if (runtime.earlyExitedPtyIncarnations.has(ptyId)) {
    const exitedIncarnation = runtime.earlyExitedPtyIncarnations.get(ptyId) ?? null
    const nextIncarnation = candidateIncarnation ?? null
    if (
      exitedIncarnation === null ||
      nextIncarnation === null ||
      exitedIncarnation === nextIncarnation
    ) {
      throw new Error('agent_session_exited_during_start')
    }
    runtime.earlyExitedPtyIncarnations.delete(ptyId)
  }
}

export function beginPtyRegistration(
  ptyId: string,
  incarnationId: PtyIncarnationId | undefined,
  runtime: OrcaRuntimeLivenessVerdictApi
): void {
  runtime.pendingPtyRegistrationIncarnations.set(ptyId, incarnationId ?? null)
}

export function cancelPendingPtyRegistration(
  ptyId: string,
  incarnationId: PtyIncarnationId | undefined,
  runtime: OrcaRuntimeLivenessVerdictApi
): void {
  const pending = runtime.pendingPtyRegistrationIncarnations.get(ptyId)
  if (
    !runtime.pendingPtyRegistrationIncarnations.has(ptyId) ||
    (pending !== null && incarnationId !== undefined && pending !== incarnationId)
  ) {
    return
  }
  runtime.pendingPtyRegistrationIncarnations.delete(ptyId)
  const exited = runtime.earlyExitedPtyIncarnations.get(ptyId)
  if (
    exited === null ||
    exited === undefined ||
    incarnationId === undefined ||
    exited === incarnationId
  ) {
    runtime.earlyExitedPtyIncarnations.delete(ptyId)
  }
}

export function releaseRejectedPtyRegistrationFence(
  ptyId: string,
  candidateIncarnation: PtyIncarnationId | undefined,
  runtime: OrcaRuntimeLivenessVerdictApi
): void {
  if (!runtime.earlyExitedPtyIncarnations.has(ptyId)) {
    return
  }
  const exitedIncarnation = runtime.earlyExitedPtyIncarnations.get(ptyId) ?? null
  if (
    exitedIncarnation === null ||
    candidateIncarnation === undefined ||
    exitedIncarnation === candidateIncarnation
  ) {
    runtime.earlyExitedPtyIncarnations.delete(ptyId)
    runtime.pendingPtyRegistrationIncarnations.delete(ptyId)
  }
}

export function onPtySpawned(
  ptyId: string,
  incarnationId: PtyIncarnationId | undefined,
  options: { awaitsRegistration?: boolean } = {},
  runtime: OrcaRuntimeLivenessVerdictApi
): void {
  runtime.forgetPtyLivenessVerdict(ptyId)
  if (options.awaitsRegistration !== false) {
    runtime.pendingPtyRegistrationIncarnations.set(ptyId, incarnationId ?? null)
  }
  const pty = runtime.getOrCreatePtyWorktreeRecord(ptyId)
  if (pty) {
    if (incarnationId) {
      ;(pty as any).incarnationId = incarnationId
    }
    ;(pty as any).connected = true
    ;(pty as any).disconnectedAt = null
  }
  for (const leaf of runtime.getLeavesForPty(ptyId)) {
    ;(leaf as any).connected = true
    ;(leaf as any).writable = runtime.graphStatus === 'ready'
    runtime.adoptPreAllocatedHandle(leaf)
  }
}

export function registerPty(
  ptyId: string,
  worktreeId: string,
  connectionId: string | null = null,
  binding: {
    tabId: string
    leafId: string
    incarnationId?: PtyIncarnationId
    agentLaunchAuthority?: { launchToken: string; launchAgent: TuiAgent }
    providerReattachLaunchIdentity?: {
      incarnationId: PtyIncarnationId
      launchAgent: TuiAgent
    }
  } | undefined,
  isWsl: boolean | undefined,
  runtime: OrcaRuntimeLivenessVerdictApi,
  helpers: {
    isValidTerminalTabId: (id: string) => boolean
    isTerminalLeafId: (id: string) => boolean
    makePaneKey: (tabId: string, leafId: string) => string
    isTuiAgent: (agent: TuiAgent) => boolean
  }
): void {
  assertPtyDidNotExitBeforeRegistration(ptyId, binding?.incarnationId, runtime)
  runtime.forgetPtyLivenessVerdict(ptyId)
  runtime.spawnPublishedPtys.add(ptyId)

  const paneKey =
    binding && helpers.isValidTerminalTabId(binding.tabId) && helpers.isTerminalLeafId(binding.leafId)
      ? helpers.makePaneKey(binding.tabId, binding.leafId)
      : null
  const pty = runtime.recordPtyWorktree(ptyId, worktreeId, {
    connected: true,
    connectionId,
    ...(binding && runtime.pendingMobileTerminalCreatesByKey.has(`${worktreeId}::${binding.tabId}`)
      ? { runtimeSessionOwned: true }
      : {}),
    ...(isWsl !== undefined ? { isWsl } : {}),
    ...(binding && paneKey ? { tabId: binding.tabId, paneKey } : {}),
    ...(binding?.incarnationId ? { incarnationId: binding.incarnationId } : {})
  })
  const agentLaunchAuthority = binding?.agentLaunchAuthority
  if (
    agentLaunchAuthority &&
    paneKey &&
    binding.incarnationId &&
    (pty as any).incarnationId === binding.incarnationId &&
    (pty as any).paneKey === paneKey &&
    (pty as any).launchToken === null &&
    agentLaunchAuthority.launchToken.length > 0 &&
    agentLaunchAuthority.launchToken.length <= 128 &&
    helpers.isTuiAgent(agentLaunchAuthority.launchAgent)
  ) {
    ;(pty as any).launchToken = agentLaunchAuthority.launchToken
    ;(pty as any).launchIncarnationId = binding.incarnationId
    ;(pty as any).launchAgent = agentLaunchAuthority.launchAgent
  }
  const providerReattachLaunchIdentity = binding?.providerReattachLaunchIdentity
  if (
    providerReattachLaunchIdentity &&
    paneKey &&
    binding.incarnationId === providerReattachLaunchIdentity.incarnationId &&
    (pty as any).incarnationId === providerReattachLaunchIdentity.incarnationId &&
    (pty as any).paneKey === paneKey &&
    helpers.isTuiAgent(providerReattachLaunchIdentity.launchAgent)
  ) {
    ;(pty as any).launchAgent = providerReattachLaunchIdentity.launchAgent
  }
  const pendingIncarnation = runtime.pendingPtyRegistrationIncarnations.get(ptyId)
  if (
    pendingIncarnation === null ||
    pendingIncarnation === undefined ||
    binding?.incarnationId === undefined ||
    pendingIncarnation === binding.incarnationId
  ) {
    runtime.pendingPtyRegistrationIncarnations.delete(ptyId)
  }
  if (binding && paneKey) {
    runtime.ensurePtyBackedMobileSurfaceForRendererTab(worktreeId, binding.tabId)
  }
}
