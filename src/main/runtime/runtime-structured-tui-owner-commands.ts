import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { resolveLocalWindowsAgentStartupShell } from '../../shared/windows-terminal-shell'
import { resolveTuiAgentLaunchArgs } from '../../shared/tui-agent-launch-defaults'
import { resolveCodexStructuredAppServerArgs } from '../codex/codex-structured-app-server-args'
import { waitForStructuredTuiExitProof } from './structured-tui-exit-proof'
import { hasStructuredTuiIdleEvidence } from './structured-tui-idle-evidence'
import { isKnownReadyPromptPreview } from './runtime-tail-projection'
import { buildTerminalWaitText, detectTerminalWaitBlockedReason } from './runtime-tail-projection'
import { stopStructuredSessionProcess } from './agent-session-owner-process-stop'
import type { StructuredTuiOwner } from '../native-chat/agent-session-wire/structured-agent-session-handoff-types'
import type { RuntimeTerminalAgentStatus } from '../../shared/runtime-types'
import type { RuntimePtyWorktreeRecord, RuntimeStore } from './orca-runtime'

export type RuntimeStructuredTuiOwnerCommandsDeps = {
  getStore: () => RuntimeStore | null
  ptysById: Map<string, RuntimePtyWorktreeRecord>
  getFreshExplicitAgentStatusForHandle: (
    handle: string,
    paneKeyOverride?: string | null
  ) => { status: NonNullable<RuntimeTerminalAgentStatus['status']> } | null
  requireStore: () => RuntimeStore
  issueStructuredTuiPtyHandle: (pty: RuntimePtyWorktreeRecord) => string
  waitForStructuredTuiPtyExit: (ptyId: string) => Promise<void>
  closeTerminal: (handle: string) => Promise<unknown>
}

export class RuntimeStructuredTuiOwnerCommands {
  constructor(private readonly deps: RuntimeStructuredTuiOwnerCommandsDeps) {}

  resolveConfiguredCodexStructuredArgs(): string[] {
    const settings = this.deps.requireStore().getSettings()
    const shell = resolveLocalWindowsAgentStartupShell({
      platform: process.platform,
      isRemote: false,
      terminalWindowsShell: settings.terminalWindowsShell
    })
    return resolveCodexStructuredAppServerArgs(
      resolveTuiAgentLaunchArgs('codex', settings.agentDefaultArgs),
      shell ?? 'posix'
    )
  }

  async closeStructuredTuiOwner(owner: StructuredTuiOwner): Promise<{ transcriptPath?: string }> {
    if (this.deps.ptysById.get(owner.terminal.ptyId)?.connected) {
      const current = this.refreshStructuredTuiOwnerBinding(owner)
      try {
        await this.deps.closeTerminal(current.terminal.handle)
      } catch (error) {
        if (this.deps.ptysById.get(owner.terminal.ptyId)?.connected) {
          throw error
        }
      }
    }
    await this.waitForStructuredTuiOwnerExit(owner)
    return owner.transcriptPath ? { transcriptPath: owner.transcriptPath } : {}
  }

  // The new exact `codex resume <thread>` child proves the resumed owner without
  // a first turn; the pinned rollout then binds its durable transcript.
  refreshStructuredTuiOwnerBinding(owner: StructuredTuiOwner): StructuredTuiOwner {
    const pty = this.deps.ptysById.get(owner.terminal.ptyId)
    if (!pty?.connected) {
      throw new Error('The owning agent terminal lost its launch identity.')
    }
    const handle = this.deps.issueStructuredTuiPtyHandle(pty)
    if (handle === owner.terminal.handle) {
      return owner
    }
    return { ...owner, terminal: { ...owner.terminal, handle } }
  }

  async waitForStructuredTuiOwnerExit(owner: StructuredTuiOwner): Promise<void> {
    await waitForStructuredTuiExitProof({
      identity: owner.process,
      waitForExit: () => this.deps.waitForStructuredTuiPtyExit(owner.terminal.ptyId)
    })
  }

  async waitForStructuredTuiIdleOrExit(
    owner: StructuredTuiOwner,
    signal: AbortSignal
  ): Promise<'idle' | 'exited' | null> {
    const deadline = Date.now() + 250
    while (!signal.aborted && Date.now() < deadline) {
      if (!this.deps.ptysById.get(owner.terminal.ptyId)?.connected) {
        await this.waitForStructuredTuiOwnerExit(owner)
        return 'exited'
      }
      if (this.structuredTuiStatus(owner) === 'idle') {
        return 'idle'
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return null
  }

  stopStructuredSessionProcess(record: AgentSessionRecord): Promise<void> {
    return stopStructuredSessionProcess(record)
  }

  structuredTuiStatus(owner: StructuredTuiOwner): 'idle' | 'busy' {
    const pty = this.deps.ptysById.get(owner.terminal.ptyId)
    const paneKey = pty?.paneKey ?? owner.terminal.paneKey
    const explicit = this.deps.getFreshExplicitAgentStatusForHandle(owner.terminal.handle, paneKey)
    if (explicit) {
      return explicit.status === 'idle' ? 'idle' : 'busy'
    }
    if (pty?.connected) {
      const text = buildTerminalWaitText(pty.tailBuffer, pty.tailPartialLine, pty.preview)
      const blocked = detectTerminalWaitBlockedReason(text) !== null
      if (!blocked && isKnownReadyPromptPreview(text)) {
        return 'idle'
      }
      return hasStructuredTuiIdleEvidence({
        blocked,
        status: pty.lastAgentStatus,
        statusObservedLive: pty.lastAgentStatusObservedLive
      })
        ? 'idle'
        : 'busy'
    }
    return 'busy'
  }
}
