/* eslint-disable max-lines -- Why: extracted agent-cluster structured-commands command cluster moved from the facade god class */
import type { AgentSessionOwnerBinding } from '../../shared/agent-session-host-authority'
import {
  agentSessionProviderHandleRoot,
  agentSessionProviderHandlesEqual
} from '../../shared/agent-session-provider-handle'
import {
  cloneAgentSessionOwnerBinding,
  scopedAgentSessionClaimsEqual
} from '../../shared/claimed-agent-pty-owner-snapshot'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type {
  RuntimeMobileSessionAgentTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import { makePaneKey } from '../../shared/stable-pane-id'
import { structuredAgentSessionTabId } from '../../shared/structured-agent-session-projection'
import { resolveTuiAgentLaunchEnv } from '../../shared/tui-agent-launch-defaults'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import type { TuiAgent } from '../../shared/tui-agent'
import { claudeProviderHandleLink } from '../claude/claude-structured-owner-identity'
import { getSystemCodexHomePath } from '../codex/codex-home-paths'
import { readCodexResumeProcessIdentity } from '../codex/codex-resume-process-proof'
import { codexProviderHandleLink } from '../codex/codex-structured-owner-identity'
import { resolvePinnedCodexRolloutProof } from '../codex/codex-tui-rollout-proof'
import type { AgentSessionAttachParams } from '../native-chat/agent-session-wire/structured-agent-session-attach'
import type {
  StructuredAgentSessionHandoffTransport,
  StructuredTuiOwner
} from '../native-chat/agent-session-wire/structured-agent-session-handoff-types'
import { StructuredTuiLaunchCleanupError } from '../native-chat/agent-session-wire/structured-agent-session-handoff-types'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import { canonicalizeAgentSessionIdentity } from './agent-session-claim-identity'
import { probeAgentSessionProcessIdentity } from './agent-session-process-identity-probe'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'
import { getRuntimeFileTargetExecutionHostId } from './orca-runtime-files'
import { OrchestrationError } from './orchestration/orchestration-error'
import {
  resolveTerminalSessionWorktreeId,
  runtimeWorktreeIdsEqual
} from './runtime-tail-projection'
import { collectSavedStructuredAgentSessionIds } from './saved-structured-agent-session-restoration'
import {
  hasPersistedStructuredAgentSessionStore as hasPersistedStructuredAgentSessionStoreOnDisk,
  ensureStructuredAgentSessionHost as installStructuredAgentSessionHost
} from './structured-agent-session-runtime'
import { readStructuredTuiProcessIdentity } from './structured-tui-process-identity'
import { evaluateStructuredTuiRecoveryClaim } from './structured-tui-recovery-claim-match'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type {
  RuntimeAgentClusterFacade,
  RuntimeAgentClusterFacadeDeps
} from './runtime-agent-cluster-facade'

export class RuntimeStructuredAgentSessionCommands {
  constructor(
    private readonly host: RuntimeAgentClusterFacade,
    deps: RuntimeAgentClusterFacadeDeps
  ) {
    this.deps = deps
  }
  private readonly deps: RuntimeAgentClusterFacadeDeps
  private structuredAgentSessionTabRestorePromise: Promise<void> | null = null
  private structuredAgentSessionStartupRestorePromise: Promise<void> | null = null

  closeStructuredAgentSessionTab(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionAgentTab
  ): void {
    const nextTabs = snapshot.tabs.filter((candidate) => candidate.id !== tab.id)
    const active = nextTabs.find((candidate) => candidate.isActive) ?? nextTabs[0] ?? null
    const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      snapshotVersion: snapshot.snapshotVersion + 1,
      activeTabId: active?.id ?? null,
      activeTabType: active?.type ?? null,
      tabGroups: (snapshot.tabGroups ?? []).map((group) => ({
        ...group,
        tabOrder: group.tabOrder.filter((id) => id !== tab.id),
        activeTabId: group.activeTabId === tab.id ? null : group.activeTabId,
        recentTabIds: group.recentTabIds?.filter((id) => id !== tab.id)
      })),
      tabs: nextTabs
    }
    this.deps.mobileSessionTabsByWorktree().set(worktreeId, nextSnapshot)
    this.deps.emitMobileSessionTabsSnapshot(nextSnapshot)
  }

  createStructuredAgentSessionHandoffTransport(): StructuredAgentSessionHandoffTransport {
    return {
      hostLabel: hostname(),
      launchTui: async ({ record, fence, spawnToken, onSpawned }) => {
        const head = record.providerHandleChain.at(-1)
        if (!head || (head.handle.provider !== 'codex' && head.handle.provider !== 'claude')) {
          throw new Error('agent_session_identity_required')
        }
        const provider = head.handle.provider
        const providerSessionId =
          provider === 'claude' ? head.handle.sessionId : head.handle.threadId
        const launchStartedAt = Date.now()
        const launched = await this.host.ensureAgentSession(
          {
            kind: 'explicit',
            worktree: `id:${record.location.workspaceId}`,
            agent: provider,
            providerSession: { key: 'session_id', id: providerSessionId },
            ...(record.options ? { launchPreferences: record.options } : {}),
            presentation: 'background'
          },
          {},
          { spawnToken, providerRoot: record.accountHome.path, sessionId: record.sessionId }
        )
        const terminal = launched.terminal
        let spawnedOwner: StructuredTuiOwner | null = null
        let ptyId: string | undefined
        try {
          if (!terminal.processId || !terminal.paneKey || !terminal.tabId || !terminal.ptyId) {
            throw new Error('The resumed terminal did not publish a process identity.')
          }
          ptyId = terminal.ptyId
          spawnedOwner = this.deps.refreshStructuredTuiOwnerBinding({
            terminal: {
              handle: terminal.handle,
              tabId: terminal.tabId,
              paneKey: terminal.paneKey,
              ptyId: terminal.ptyId
            },
            process:
              provider === 'codex'
                ? await readCodexResumeProcessIdentity({
                    hostId: record.location.executionHostId,
                    rootPid: terminal.processId,
                    spawnToken,
                    threadId: head.handle.threadId
                  })
                : await readStructuredTuiProcessIdentity({
                    hostId: record.location.executionHostId,
                    rootPid: terminal.processId,
                    spawnToken,
                    agent: provider
                  }),
            link:
              provider === 'codex'
                ? codexProviderHandleLink({
                    threadId: head.handle.threadId,
                    resumed: true,
                    fence,
                    observedAt: Date.now()
                  })
                : claudeProviderHandleLink({
                    sessionId: head.handle.sessionId,
                    leafUuid: head.handle.leafUuid,
                    resumed: true,
                    fence,
                    observedAt: Date.now()
                  })
          })
          await onSpawned?.(spawnedOwner)
          await this.deps.waitForTerminal(terminal.handle, {
            condition: 'tui-idle',
            timeoutMs: 30_000
          })
          const proof =
            provider === 'codex'
              ? await this.deps.waitForAdoptedStructuredTuiProof({
                  owner: spawnedOwner,
                  threadId: head.handle.threadId,
                  codexHome: record.accountHome.path
                })
              : await this.deps.waitForStructuredClaudeTuiProof({
                  handle: terminal.handle,
                  paneKey: terminal.paneKey,
                  sessionId: head.handle.sessionId,
                  previousLeafUuid: head.handle.leafUuid,
                  projectsDir: join(record.accountHome.path, 'projects'),
                  spawnToken,
                  minimumProviderSessionReceivedAt: launchStartedAt
                })
          const revealed = await this.deps.focusTerminal(terminal.handle, {})
          return this.deps.refreshStructuredTuiOwnerBinding({
            ...spawnedOwner,
            link:
              provider === 'claude'
                ? claudeProviderHandleLink({
                    sessionId: head.handle.sessionId,
                    leafUuid: proof.leafUuid ?? head.handle.leafUuid,
                    resumed: true,
                    fence,
                    observedAt: Date.now()
                  })
                : spawnedOwner.link,
            terminal: {
              handle: terminal.handle,
              tabId: revealed.tabId,
              paneKey: terminal.paneKey,
              ptyId: terminal.ptyId
            },
            process: spawnedOwner.process,
            ...(proof.transcriptPath ? { transcriptPath: proof.transcriptPath } : {}),
            historySource: 'provider-resume'
          })
        } catch (error) {
          let closeError: unknown = null
          try {
            await this.deps.closeTerminal(terminal.handle)
          } catch (cleanupFailure) {
            closeError = cleanupFailure
          }
          try {
            // closeTerminal may retire the renderer handle before the PTY exit is
            // observed. Prove the provider child (or, before identity publication,
            // the PTY) through the same exit path used by handoff recovery.
            if (spawnedOwner) {
              await this.deps.waitForStructuredTuiOwnerExit(spawnedOwner)
            } else if (ptyId) {
              await this.deps.waitForStructuredTuiPtyExit(ptyId)
            } else {
              throw new Error('The failed terminal did not publish a PTY identity.')
            }
          } catch (exitFailure) {
            throw new StructuredTuiLaunchCleanupError(
              error,
              closeError === null
                ? exitFailure
                : new AggregateError(
                    [closeError, exitFailure],
                    'Structured TUI cleanup could not prove process exit.'
                  )
            )
          }
          throw error
        }
      },
      waitForTuiExit: async (owner) => {
        await this.deps.waitForStructuredTuiOwnerExit(owner)
        return owner.transcriptPath ? { transcriptPath: owner.transcriptPath } : {}
      },
      waitForTuiIdleOrExit: async (owner, signal) => {
        return this.deps.waitForStructuredTuiIdleOrExit(owner, signal)
      },
      reproveTuiOwner: async ({ record, owner }) => {
        const current = this.deps.refreshStructuredTuiOwnerBinding(owner)
        const persisted = record.lease.ownerProcess
        if (
          !persisted ||
          persisted.hostId !== current.process.hostId ||
          persisted.pid !== current.process.pid ||
          persisted.processStartTimeMs !== current.process.processStartTimeMs ||
          persisted.spawnToken !== current.process.spawnToken
        ) {
          throw new Error('The owning terminal does not match the persisted launch identity.')
        }
        const proof = await probeAgentSessionProcessIdentity({ identity: current.process })
        if (proof.outcome !== 'identity-matched' || proof.matchedOn.length === 0) {
          throw new Error(
            `The owning ${current.link.handle.provider} child process could not be re-proved.`
          )
        }
        const head = record.providerHandleChain.at(-1)
        const sameProviderIdentity =
          head &&
          (current.link.handle.provider === 'claude'
            ? agentSessionProviderHandleRoot(current.link.handle) ===
              agentSessionProviderHandleRoot(head.handle)
            : (record.lease.provenHandleLinkId === null ||
                current.link.linkId === record.lease.provenHandleLinkId) &&
              agentSessionProviderHandlesEqual(current.link.handle, head.handle))
        if (!sameProviderIdentity) {
          throw new Error('agent_session_identity_required')
        }
        if (current.link.handle.provider === 'claude' && head.handle.provider === 'claude') {
          const proof = await this.deps.waitForStructuredClaudeTuiProof({
            handle: current.terminal.handle,
            paneKey: current.terminal.paneKey,
            sessionId: head.handle.sessionId,
            previousLeafUuid: head.handle.leafUuid,
            projectsDir: join(record.accountHome.path, 'projects')
          })
          return {
            ...current,
            link: claudeProviderHandleLink({
              sessionId: head.handle.sessionId,
              leafUuid: proof.leafUuid,
              resumed: true,
              fence: record.lease.runtimeFence,
              observedAt: Date.now()
            }),
            transcriptPath: proof.transcriptPath
          }
        }
        if (current.transcriptPath || current.link.handle.provider !== 'codex') {
          return current
        }
        if (head.handle.provider !== 'codex') {
          return current
        }
        const threadId = head.handle.threadId
        const transcriptPath = await resolvePinnedCodexRolloutProof(
          record.accountHome.path,
          threadId
        )
        return transcriptPath ? { ...current, transcriptPath } : current
      },
      recoverTuiOwner: async (record) => {
        const identity = record.lease.ownerProcess
        const head = record.providerHandleChain.at(-1)
        if (
          !identity ||
          !head ||
          (head.handle.provider !== 'codex' && head.handle.provider !== 'claude')
        ) {
          throw new Error('agent_session_identity_required')
        }
        const provider = head.handle.provider
        const providerSessionId =
          provider === 'claude' ? head.handle.sessionId : head.handle.threadId
        let candidate = [...this.deps.ptysById().values()].find(
          (pty) =>
            pty.connected &&
            pty.launchToken === identity.spawnToken &&
            pty.launchAgent === provider &&
            pty.tabId &&
            pty.paneKey
        )
        let handle = candidate ? this.deps.issueStructuredTuiPtyHandle(candidate) : null
        let durableOwner: { binding: AgentSessionOwnerBinding; incarnationId: string } | undefined
        if (!candidate) {
          const workspace = await this.deps.resolveTerminalWorkspaceLaunchScope(
            `id:${record.location.workspaceId}`
          )
          const baseNamespace = this.host.getAgentSessionExecutionNamespace(workspace, provider)
          if (
            !baseNamespace ||
            !runtimeWorktreeIdsEqual(workspace.id, record.location.workspaceId)
          ) {
            throw new Error('agent_session_identity_required')
          }
          const claim = this.deps.agentSessionClaimSigner().createClaim({
            namespace: { ...baseNamespace, providerRoot: record.accountHome.path },
            identity: canonicalizeAgentSessionIdentity(provider, {
              key: 'session_id',
              id: providerSessionId
            }),
            canonicalWorktreeId: workspace.id
          })
          const candidateEvaluations = [...this.deps.ptysById().values()].flatMap((pty) =>
            pty.agentSessionOwners.map((owner) => {
              const session = this.deps.getWorkspaceSessionForWorktree(owner.surface.worktreeId)
              const sessionWorktreeId = session
                ? resolveTerminalSessionWorktreeId(session, owner.surface.worktreeId)
                : null
              const persistedTab = sessionWorktreeId
                ? session?.tabsByWorktree[sessionWorktreeId]?.find(
                    (candidate) => candidate.id === owner.surface.tabId
                  )
                : null
              const paneKey = makePaneKey(owner.surface.tabId, owner.surface.leafId)
              const persisted = {
                sessionResolved: Boolean(session && sessionWorktreeId),
                tabPresent: Boolean(persistedTab),
                ptyId:
                  session?.terminalLayoutsByTabId[owner.surface.tabId]?.ptyIdsByLeafId?.[
                    owner.surface.leafId
                  ] ?? null,
                incarnationId: session?.terminalPtyIncarnationsByPaneKey?.[paneKey] ?? null
              }
              const evaluation = evaluateStructuredTuiRecoveryClaim(
                {
                  expectedWorkspaceId: workspace.id,
                  claimMatches: scopedAgentSessionClaimsEqual(owner.claim, claim),
                  pty: {
                    connected: pty.connected,
                    ptyId: pty.ptyId,
                    incarnationId: pty.incarnationId,
                    worktreeId: pty.worktreeId
                  },
                  owner: {
                    phase: owner.phase,
                    ptyId: owner.ptyId,
                    surface: owner.surface
                  },
                  persisted
                },
                runtimeWorktreeIdsEqual
              )
              return { pty, owner, persisted, evaluation }
            })
          )
          const recoveredCandidates = candidateEvaluations
            .filter(({ evaluation }) => evaluation.matches)
            .map(({ pty, owner }) => ({ pty, owner }))
          const recovered = recoveredCandidates.length === 1 ? recoveredCandidates[0] : null
          if (!recovered) {
            console.warn('[structured-tui-recovery] claim mismatch', {
              sessionId: record.sessionId,
              expectedWorkspaceId: workspace.id,
              persistedOwnerProcess: {
                hostId: identity.hostId,
                pid: identity.pid,
                processStartTimeMs: identity.processStartTimeMs,
                spawnTokenPresent: identity.spawnToken.length > 0
              },
              candidates: candidateEvaluations.map(({ pty, owner, persisted, evaluation }) => ({
                ptyId: pty.ptyId,
                incarnationId: pty.incarnationId,
                worktreeId: pty.worktreeId,
                ownerSurface: owner.surface,
                persisted,
                mismatchedFields: evaluation.mismatchedFields
              }))
            })
          }
          if (
            !recovered ||
            !(await this.deps.proveRecoveredStructuredTuiPtyProcess(
              recovered.pty,
              identity,
              provider
            ))
          ) {
            throw new Error('The owning agent terminal could not be recovered.')
          }
          candidate = recovered.pty
          candidate.tabId = recovered.owner.surface.tabId
          candidate.paneKey = makePaneKey(
            recovered.owner.surface.tabId,
            recovered.owner.surface.leafId
          )
          // Runtime handles rotate on packaged relaunch; claim, incarnation, and process proof are durable.
          handle = this.deps.issuePtyHandle(candidate)
          const recoveredIncarnationId = candidate.incarnationId
          if (handle && recoveredIncarnationId) {
            durableOwner = {
              binding: cloneAgentSessionOwnerBinding(recovered.owner),
              incarnationId: recoveredIncarnationId
            }
          }
        }
        if (!candidate?.tabId || !candidate.paneKey || !handle) {
          throw new Error('The owning agent terminal could not be recovered.')
        }
        agentSessionPtyWriteGate.bindPty(candidate.ptyId, record.sessionId)
        const proof =
          provider === 'codex'
            ? durableOwner
              ? await this.deps.resolveRecoveredStructuredTuiTranscript({
                  handle,
                  paneKey: candidate.paneKey,
                  threadId: head.handle.threadId,
                  codexHome: record.accountHome.path,
                  durableOwner
                })
              : await this.deps.waitForStructuredTuiProof({
                  handle,
                  paneKey: candidate.paneKey,
                  threadId: head.handle.threadId,
                  spawnToken: identity.spawnToken,
                  codexHome: record.accountHome.path,
                  sessionId: record.sessionId
                })
            : await this.deps.waitForStructuredClaudeTuiProof({
                handle,
                paneKey: candidate.paneKey,
                sessionId: head.handle.sessionId,
                previousLeafUuid: head.handle.leafUuid,
                projectsDir: join(record.accountHome.path, 'projects')
              })
        return {
          terminal: {
            handle,
            tabId: candidate.tabId,
            paneKey: candidate.paneKey,
            ptyId: candidate.ptyId
          },
          process: identity,
          link:
            provider === 'codex'
              ? codexProviderHandleLink({
                  threadId: head.handle.threadId,
                  resumed: true,
                  fence: record.lease.runtimeFence,
                  observedAt: Date.now()
                })
              : claudeProviderHandleLink({
                  sessionId: head.handle.sessionId,
                  leafUuid: proof.leafUuid ?? head.handle.leafUuid,
                  resumed: true,
                  fence: record.lease.runtimeFence,
                  observedAt: Date.now()
                }),
          transcriptPath: proof.transcriptPath
        }
      },
      probeRecoveredOwner: async (record) => {
        const identity = record.lease.ownerProcess
        if (!identity) {
          return 'dead'
        }
        const proof = await probeAgentSessionProcessIdentity({ identity })
        if (proof.outcome === 'identity-matched' && proof.matchedOn.length > 0) {
          return 'live'
        }
        if (proof.outcome === 'pid-absent' || proof.outcome === 'identity-mismatch') {
          return 'dead'
        }
        return 'unknown'
      },
      stopRecoveredOwner: (record) => this.deps.stopStructuredSessionProcess(record),
      tuiStatus: (owner) => this.deps.structuredTuiStatus(owner),
      closeTuiOwner: (owner) => this.deps.closeStructuredTuiOwner(owner),
      revealNativeSession: ({ workspaceId, sessionId, agent = 'codex', adoptedTerminal }) => {
        if (adoptedTerminal || agent !== 'codex') {
          return
        }
        this.publishStructuredAgentSessionTab({
          workspaceId,
          sessionId,
          agent,
          activate: false
        })
        this.deps.notifier()?.focusEditorTab?.(structuredAgentSessionTabId(sessionId), workspaceId)
      },
      stopFailedTuiLaunch: async (owner) => void (await this.deps.closeStructuredTuiOwner(owner))
    }
  }

  async ensureStructuredAgentSessionHost(): Promise<void> {
    await installStructuredAgentSessionHost({
      stateDirectory: getProfileUserDataPath(),
      hostId: LOCAL_EXECUTION_HOST_ID,
      claimKeyId: this.deps.agentSessionClaimSigner().keyId,
      // Resolves folder workspaces as well as git worktrees, so a chat session
      // in a plain folder lands in the folder rather than failing to resolve.
      resolveWorkspacePath: async (workspaceId) =>
        (await this.deps.resolveRuntimeFileTarget(`id:${workspaceId}`)).worktree.path,
      resolveLaunchArgs: () => this.deps.resolveConfiguredCodexStructuredArgs(),
      resolveLaunchEnvOverlay: () =>
        resolveTuiAgentLaunchEnv('codex', this.deps.requireStore().getSettings().agentDefaultEnv),
      handoffTransport: this.createStructuredAgentSessionHandoffTransport()
    })
  }

  async getStructuredAgentSessionCreateSupport(
    worktreeSelector: string,
    agent: 'codex'
  ): Promise<{ supported: boolean; reason?: 'agent' | 'remote' | 'wsl' }> {
    const location = await this.resolveStructuredAgentSessionLocation(worktreeSelector)
    await this.ensureStructuredAgentSessionHost()
    if (getStructuredAgentSessionHost()?.supportsCreate(location, agent)) {
      return { supported: true }
    }
    return {
      supported: false,
      reason:
        location.executionHostId !== LOCAL_EXECUTION_HOST_ID
          ? 'remote'
          : location.wslDistro
            ? 'wsl'
            : 'agent'
    }
  }

  hasPersistedStructuredAgentSessionStore(): boolean {
    return hasPersistedStructuredAgentSessionStoreOnDisk(getProfileUserDataPath())
  }

  prepareStructuredAgentSessionStartupRestoration(): Promise<void> {
    this.structuredAgentSessionStartupRestorePromise ??=
      this.prepareStructuredAgentSessionStartupRestorationOnce().catch((error) => {
        this.structuredAgentSessionStartupRestorePromise = null
        throw error
      })
    return this.structuredAgentSessionStartupRestorePromise
  }

  async prepareStructuredAgentSessionStartupRestorationOnce(): Promise<void> {
    if (!this.hasPersistedStructuredAgentSessionStore()) {
      return
    }
    // Durable agent records must exist before daemon inventory can be reconciled against them.
    await this.ensureStructuredAgentSessionHost()
    await this.deps.refreshMobileSessionPtyRecords(null)
    await getStructuredAgentSessionHost()?.reconcileRestartLeases()
  }

  publishStructuredAgentSessionTab(input: {
    workspaceId: string
    sessionId: string
    agent: 'codex'
    activate: boolean
    notify?: boolean
  }): void {
    const existing = this.deps.mobileSessionTabsByWorktree().get(input.workspaceId)
    const id = `agent-session:${input.sessionId}`
    if (existing?.tabs.some((tab) => tab.id === id)) {
      return
    }
    const tab: RuntimeMobileSessionAgentTab = {
      type: 'agent-session',
      id,
      title: 'Codex Chat',
      sessionId: input.sessionId,
      agent: input.agent,
      isActive: input.activate
    }
    const tabs = [...(existing?.tabs ?? [])].map((candidate) => ({
      ...candidate,
      isActive: input.activate ? false : candidate.isActive
    }))
    tabs.push(tab)
    const priorGroups = existing?.tabGroups ?? [
      {
        id: this.deps.getHeadlessMobileSessionGroupId(input.workspaceId),
        activeTabId: existing?.activeTabId ?? null,
        tabOrder: []
      }
    ]
    const groupId = priorGroups.some((group) => group.id === existing?.activeGroupId)
      ? existing!.activeGroupId!
      : priorGroups[0]!.id
    const tabGroups = priorGroups.map((group) =>
      group.id === groupId
        ? {
            ...group,
            activeTabId: input.activate ? id : group.activeTabId,
            tabOrder: [...group.tabOrder, id]
          }
        : group
    )
    const snapshot: RuntimeMobileSessionTabsSnapshot = {
      worktree: input.workspaceId,
      publicationEpoch: existing?.publicationEpoch ?? `structured:${Date.now().toString(36)}`,
      snapshotVersion: (existing?.snapshotVersion ?? 0) + 1,
      activeGroupId: input.activate ? groupId : (existing?.activeGroupId ?? groupId),
      activeTabId: input.activate ? id : (existing?.activeTabId ?? null),
      activeTabType: input.activate ? 'agent-session' : (existing?.activeTabType ?? null),
      tabGroups,
      ...(existing?.tabGroupLayout ? { tabGroupLayout: existing.tabGroupLayout } : {}),
      tabs
    }
    this.deps.mobileSessionTabsByWorktree().set(input.workspaceId, snapshot)
    if (input.notify !== false) {
      this.deps.emitMobileSessionTabsSnapshot(snapshot)
    }
  }

  async resolveStructuredAgentSessionCreateIntent(input: {
    envelope: { sessionId: string; clientOperationId: string }
    worktree: string
    agent: 'codex'
  }): Promise<AgentSessionAttachParams> {
    return this.resolveStructuredAgentSessionIntent(input, async ({ workspacePath, launchEnv }) => {
      // A create has no process yet, so the current selection is what it must follow.
      const preparedHome = await this.deps.prepareCodexStructuredLaunchFn()?.({
        workspacePath,
        launchEnv
      })
      const configuredHome = launchEnv.CODEX_HOME
      return (
        preparedHome?.trim() ||
        (this.deps.prepareCodexStructuredLaunchFn()
          ? getSystemCodexHomePath()
          : configuredHome?.trim()) ||
        getSystemCodexHomePath()
      )
    })
  }

  async resolveStructuredAgentSessionIntent(
    input: {
      envelope: { sessionId: string; clientOperationId: string }
      worktree: string
      agent: 'codex'
    },
    resolveAccountHomePath: (context: {
      workspacePath: string
      launchEnv: NodeJS.ProcessEnv
    }) => string | Promise<string>
  ): Promise<AgentSessionAttachParams> {
    const support = await this.getStructuredAgentSessionCreateSupport(input.worktree, input.agent)
    if (!support.supported) {
      throw new Error('structured_agent_session_unsupported')
    }
    const settings = this.deps.requireStore().getSettings()
    const launchEnv = resolveTuiAgentLaunchEnv(input.agent, settings.agentDefaultEnv)
    const location = await this.resolveStructuredAgentSessionLocation(input.worktree)
    const workspacePath = (await this.deps.resolveRuntimeFileTarget(input.worktree)).worktree.path
    return {
      envelope: {
        sessionId: input.envelope.sessionId,
        clientOperationId: input.envelope.clientOperationId,
        expectedRuntimeFence: null,
        payloadFingerprint: ''
      },
      location,
      provider: input.agent,
      agent: input.agent,
      accountHome: {
        variable: 'CODEX_HOME',
        path: await resolveAccountHomePath({ workspacePath, launchEnv })
      },
      runtimeKind: 'native'
    }
  }

  async resolveStructuredAgentSessionLocation(worktreeSelector: string) {
    const target = await this.deps.resolveRuntimeFileTarget(worktreeSelector)
    const repo = this.deps.store()?.getRepo(target.worktree.repoId)
    const wslDistro =
      repo && !target.connectionId
        ? (getLocalProjectWorktreeGitOptions(this.deps.requireStore(), repo).wslDistro ?? null)
        : null
    const folderWorkspace = this.deps
      .store()
      ?.getFolderWorkspaces?.()
      .some((workspace) => workspace.id === target.worktree.id)
    return {
      executionHostId: getRuntimeFileTargetExecutionHostId({
        worktree: target.worktree,
        connectionId: target.connectionId
      }),
      wslDistro,
      workspaceId: target.worktree.id,
      workspaceKind: folderWorkspace ? ('folder' as const) : ('git-worktree' as const)
    }
  }

  restoreStructuredAgentSessionTabs(): Promise<void> {
    this.structuredAgentSessionTabRestorePromise ??=
      this.restoreStructuredAgentSessionTabsOnce().catch((error) => {
        this.structuredAgentSessionTabRestorePromise = null
        throw error
      })
    return this.structuredAgentSessionTabRestorePromise
  }

  async restoreStructuredAgentSessionTabsOnce(): Promise<void> {
    await this.prepareStructuredAgentSessionStartupRestoration()
    const host = getStructuredAgentSessionHost()
    await host?.restoreReadableSessions(
      collectSavedStructuredAgentSessionIds(
        this.deps.store()?.getWorkspaceSession?.(LOCAL_EXECUTION_HOST_ID) ?? null
      )
    )
    for (const worktreeId of this.deps.getKnownWorkspaceSessionWorktreeIds()) {
      this.deps.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId, {
        allowAttachedWindow: true,
        onlyRuntimeOwnedTerminals: true
      })
    }
    this.deps.hydrateHeadlessMobileSessionTabsFromWorkspaceSession()
    for (const session of host?.listSessionTabs() ?? []) {
      if (session.agent !== 'codex') {
        continue
      }
      let sessionId = session.sessionId
      while (sessionId.startsWith('agent-session:')) {
        sessionId = sessionId.slice('agent-session:'.length)
      }
      this.publishStructuredAgentSessionTab({
        ...session,
        agent: 'codex',
        sessionId,
        activate: false,
        notify: false
      })
    }
  }

  validateOrchestrationAgentLauncher(agent: TuiAgent): void {
    const settings = this.deps.store()?.getSettings()
    if (!settings) {
      throw new Error('runtime_unavailable')
    }
    if (!isTuiAgentEnabled(agent, settings.disabledTuiAgents)) {
      throw new OrchestrationError(
        'agent_unconfigured',
        `Agent launcher ${agent} is disabled or unavailable.`
      )
    }
  }
}
