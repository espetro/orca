import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import type { AgentSessionPtyWriteRefusal } from '../../shared/agent-session-pty-write-admission'
import type { StartupCommandDelivery } from '../../shared/codex-startup-delivery'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../shared/agent-session-resume'
import type { TuiAgent } from '../../shared/tui-agent'
import type { PtyListedSession } from '../../shared/pty-listed-session'
import type {
  PtyRendererDeliveryHealthReply,
  PtyRendererDeliveryStateReport
} from '../../shared/pty-renderer-delivery-health'
import type { TerminalViewAttributes } from '../../shared/terminal-view-attributes'
import type { PtyMainDeliveryDiagnostics } from '../../shared/pty-delivery-diagnostics'
import type { AgentKind, LaunchSource, RequestKind } from '../../shared/telemetry-events'

export const ptyBridge: Pick<
  PreloadApi['pty'],
  | 'spawn'
  | 'write'
  | 'writeAccepted'
  | 'onWriteUnavailable'
  | 'resize'
  | 'claimViewport'
  | 'reportGeometry'
  | 'signal'
  | 'clearBuffer'
  | 'ackColdRestore'
  | 'ackData'
  | 'onDeliveryResyncRequest'
  | 'respondDeliveryResync'
  | 'reportRendererDeliveryState'
  | 'getPtyDataListenerCount'
  | 'rendererDispatcherReady'
  | 'setActiveRendererPty'
  | 'setRendererPtyVisible'
  | 'setHiddenRendererPty'
  | 'setPtyDeliveryInterest'
  | 'publishTerminalViewAttributes'
  | 'kill'
  | 'listSessions'
  | 'getAuthoritativeBufferSnapshotCapabilities'
  | 'hasPty'
  | 'getMainBufferSnapshot'
  | 'getRendererDeliveryDebugSnapshot'
  | 'resetRendererDeliveryDebug'
  | 'hasChildProcesses'
  | 'getForegroundProcess'
  | 'inspectProcess'
  | 'confirmForegroundProcess'
  | 'getCwd'
  | 'getSize'
  | 'management'
> = {
  spawn: (opts: {
    cols: number
    rows: number
    cwd?: string
    cwdFallback?: 'worktree'
    env?: Record<string, string>
    envToDelete?: string[]
    command?: string
    commandDelivery?: 'renderer' | 'provider'
    launchConfig?: SleepingAgentLaunchConfig
    resumeProviderSession?: AgentProviderSessionMetadata
    launchToken?: string
    launchAgent?: TuiAgent
    startupCommandDelivery?: StartupCommandDelivery
    connectionId?: string | null
    worktreeId?: string
    sessionId?: string
    shellOverride?: string
    projectRuntime?: ProjectExecutionRuntimeResolution
    terminalColorQueryReplies?: { foreground?: string; background?: string }
    // Why: marks the PTY hidden before its first byte so the delivery gate + model responder own spawn-time queries (terminal-query-authority.md §races).
    initiallyHidden?: boolean
    // Why: closes the SIGKILL race (INVESTIGATION.md) — main sync-flushes the (worktreeId, tabId, leafId → ptyId) binding before pty:spawn returns.
    tabId?: string
    leafId?: string
    // Why: loose typing on purpose — renderer owns launch metadata, main owns whether the launch happened and validates (telemetry-plan.md §Agent launch semantics).
    telemetry?: { agent_kind: AgentKind; launch_source: LaunchSource; request_kind: RequestKind }
  }): Promise<{
    id: string
    /** Which lifetime of `id` this reply named; absent when the execution host predates the field. */
    incarnationId?: string
    launchConfig?: SleepingAgentLaunchConfig
    snapshot?: string
    snapshotCols?: number
    snapshotRows?: number
    snapshotPrefixAnsi?: string
    snapshotFrameAnsi?: string
    snapshotFrameRestoreAnsi?: string
    snapshotKittyKeyboardFlags?: number
    snapshotTerminalOwner?: 'shell'
    snapshotSeq?: number
    isReattach?: boolean
    isAlternateScreen?: boolean
    replay?: string
    sessionExpired?: boolean
    coldRestore?: { scrollback: string; cwd: string; cols?: number; rows?: number }
    startupCwdFallback?: { kind: 'worktree'; cwd: string }
    agentResumeUnavailable?: true
  }> => ipcRenderer.invoke('pty:spawn', opts),
  write: (id: string, data: string): void => {
    ipcRenderer.send('pty:write', { id, data })
  },
  writeAccepted: (id: string, data: string): Promise<boolean> =>
    ipcRenderer.invoke('pty:writeAccepted', { id, data }),
  onWriteUnavailable: (
    callback: (payload: {
      id: string
      /** Set only when a durable agent-session lease refused the write; absent otherwise. */
      agentSessionRefusal?: AgentSessionPtyWriteRefusal
    }) => void
  ): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: { id: string; agentSessionRefusal?: AgentSessionPtyWriteRefusal }
    ): void => callback(payload)
    ipcRenderer.on('pty:writeUnavailable', handler)
    return () => ipcRenderer.removeListener('pty:writeUnavailable', handler)
  },
  resize: (id: string, cols: number, rows: number): void => {
    ipcRenderer.send('pty:resize', { id, cols, rows })
  },
  claimViewport: (id: string, cols: number, rows: number): void => {
    ipcRenderer.send('pty:claimViewport', { id, cols, rows })
  },
  /** Why: measurement-only sibling of resize — keeps the runtime's restore-target baseline fresh while a mobile-fit override blocks pty:resize. Never resizes the PTY. See docs/mobile-fit-hold.md. */
  reportGeometry: (id: string, cols: number, rows: number): void => {
    ipcRenderer.send('pty:reportGeometry', { id, cols, rows })
  },
  signal: (id: string, signal: string): void => {
    ipcRenderer.send('pty:signal', { id, signal })
  },
  /** Why: Cmd/Ctrl+K clears the renderer xterm, but the PTY host keeps its own screen state and would repaint the next prompt at the stale cursor row. */
  clearBuffer: (id: string): void => {
    ipcRenderer.send('pty:clearBuffer', { id })
  },
  ackColdRestore: (id: string): void => {
    ipcRenderer.send('pty:ackColdRestore', { id })
  },
  /** charCount is the legacy per-chunk delta; processedChars is the cumulative per-pty total (self-heals under lost ACKs). */
  ackData: (id: string, charCount: number, processedChars?: number): void => {
    ipcRenderer.send('pty:ackData', {
      id,
      charCount,
      ...(typeof processedChars === 'number' ? { processedChars } : {})
    })
  },
  /** Main requests the renderer's cumulative processed totals when delivery looks stuck on lost ACKs. */
  onDeliveryResyncRequest: (callback: (payload: { requestId: number }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { requestId: number }) =>
      callback(payload)
    ipcRenderer.on('pty:requestDeliveryResync', listener)
    return () => ipcRenderer.removeListener('pty:requestDeliveryResync', listener)
  },
  respondDeliveryResync: (payload: {
    requestId: number
    processedCharsByPty: Record<string, number>
  }): void => {
    ipcRenderer.send('pty:deliveryResyncResponse', payload)
  },
  /** Renderer-initiated delivery health/heal lane — rides invoke because the field wedge (v1.4.121-rc.0) kills main→renderer push while invoke stays alive. */
  reportRendererDeliveryState: (
    report: PtyRendererDeliveryStateReport
  ): Promise<PtyRendererDeliveryHealthReply> =>
    ipcRenderer.invoke('pty:reportRendererDeliveryState', report),
  /** Live pty:data listener count — the watchdog's "listener detached" vs "channel dead" discriminator. */
  getPtyDataListenerCount: (): number => ipcRenderer.listenerCount('pty:data'),
  rendererDispatcherReady: (): void => {
    ipcRenderer.send('pty:rendererDispatcherReady')
  },
  setActiveRendererPty: (id: string, active: boolean): void => {
    ipcRenderer.send('pty:setActiveRendererPty', { id, active })
  },
  setRendererPtyVisible: (id: string, visible: boolean): void => {
    ipcRenderer.send('pty:setRendererPtyVisible', { id, visible })
  },
  /** Hidden-delivery gate: hidden=true lets main DROP renderer byte delivery after model ingestion; reveal restores from the model snapshot. Fire-and-forget. */
  setHiddenRendererPty: (id: string, hidden: boolean): void => {
    ipcRenderer.send('pty:setHiddenRendererPty', { id, hidden })
  },
  /** Delivery-interest signal: a renderer party needing raw bytes suppresses the hidden-delivery gate for that PTY while registered. */
  setPtyDeliveryInterest: (id: string, interested: boolean): void => {
    ipcRenderer.send('pty:setPtyDeliveryInterest', { id, interested })
  },
  /** Push composed terminal appearance so main's model responder can answer OSC 4/10/11/12 and DSR ?996n for hidden-gated PTYs with renderer-true values. */
  publishTerminalViewAttributes: (attributes: TerminalViewAttributes): void => {
    ipcRenderer.send('pty:terminalViewAttributes', attributes)
  },
  kill: (id: string, opts?: { keepHistory?: boolean }): Promise<void> =>
    ipcRenderer.invoke('pty:kill', { id, keepHistory: opts?.keepHistory ?? false }),
  listSessions: (): Promise<PtyListedSession[]> => ipcRenderer.invoke('pty:listSessions'),
  getAuthoritativeBufferSnapshotCapabilities: (
    ids: string[]
  ): Promise<{ id: string; authoritative: boolean | null }[]> =>
    ipcRenderer.invoke('pty:getAuthoritativeBufferSnapshotCapabilities', { ids }),
  hasPty: (id: string): Promise<boolean | null> => ipcRenderer.invoke('pty:hasPty', { id }),
  getMainBufferSnapshot: (
    id: string,
    opts?: { scrollbackRows?: number }
  ): Promise<{
    data: string
    frameRestoreAnsi?: string
    cols: number
    rows: number
    cwd?: string | null
    seq?: number
    pendingDeliveryStartSeq?: number
    source?: 'headless' | 'renderer'
    alternateScreen?: boolean
    scrollbackAnsi?: string
    pendingEscapeTailAnsi?: string
    kittyKeyboardFlags?: number
    terminalOwner?: 'shell'
  } | null> => ipcRenderer.invoke('pty:getMainBufferSnapshot', { id, opts }),
  getRendererDeliveryDebugSnapshot: (): Promise<{
    pendingPtyCount: number
    pendingChars: number
    maxPendingCharsByPty: number
    rendererInFlightPtyCount: number
    rendererInFlightChars: number
    maxRendererInFlightCharsByPty: number
    activeRendererPtyCount: number
    flushScheduled: boolean
    peakPendingChars: number
    peakMaxPendingCharsByPty: number
    peakRendererInFlightChars: number
    peakMaxRendererInFlightCharsByPty: number
    ackGatedFlushSkipCount: number
    hiddenDeliveryGatedPtyCount: number
    hiddenDeliveryGatedVisiblePtyCount: number
    hiddenDeliveryGatedActivePtyCount: number
    deliveryInterestPtyCount: number
    hiddenDeliveryDroppedChars: number
    hiddenDeliveryDroppedChunks: number
    pendingDroppedChars: number
    diagnostics: PtyMainDeliveryDiagnostics
    rendererLifecycleResetCount: number
    lastLifecycleResetClearedChars: number
    rendererPtyDispatcherReady: boolean
    rendererDispatcherReadyForcedCount: number
  }> => ipcRenderer.invoke('pty:getRendererDeliveryDebugSnapshot'),
  resetRendererDeliveryDebug: (): Promise<void> =>
    ipcRenderer.invoke('pty:resetRendererDeliveryDebug'),
  /** True if the PTY's shell has child processes (a running command); false at an idle prompt. */
  hasChildProcesses: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('pty:hasChildProcesses', { id }),
  /** Return the PTY foreground process basename when available (e.g. "codex"). */
  getForegroundProcess: (id: string): Promise<string | null> =>
    ipcRenderer.invoke('pty:getForegroundProcess', { id }),
  inspectProcess: (
    id: string
  ): Promise<{
    foregroundProcess: string | null
    hasChildProcesses: boolean
    unavailable?: true
  }> => ipcRenderer.invoke('pty:inspectProcess', { id }),
  confirmForegroundProcess: (id: string): Promise<string | null> =>
    ipcRenderer.invoke('pty:confirmForegroundProcess', { id }),
  /** Resolve a PTY's live cwd via `/proc` (Linux) or `lsof` (macOS); `''` when unknown or unresolvable. */
  getCwd: (id: string): Promise<string> => ipcRenderer.invoke('pty:getCwd', { id }),
  /** The PTY's last APPLIED size (real winsize), or null if unknown — lets the renderer detect drift after a dropped resize and re-assert. */
  getSize: (id: string): Promise<{ cols: number; rows: number } | null> =>
    ipcRenderer.invoke('pty:getSize', { id }),
  management: {
    listSessions: () => ipcRenderer.invoke('pty:management:listSessions'),
    killAll: () => ipcRenderer.invoke('pty:management:killAll'),
    killOne: (args: { sessionId: string }) => ipcRenderer.invoke('pty:management:killOne', args),
    restart: () => ipcRenderer.invoke('pty:management:restart'),
    macTccAttribution: () => ipcRenderer.invoke('pty:management:macTccAttribution')
  }
}
