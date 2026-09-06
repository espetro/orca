import type { ChildProcess } from 'node:child_process'
import { execFile } from 'node:child_process'
import { BrowserError } from './cdp-bridge'
import type { CdpWsProxy } from './cdp-ws-proxy'
import {
  pageUnavailableMessageForSession,
  translateResult,
  isTabClosedTransportError,
  classifyErrorCode
} from './agent-browser-command-expressions'
import {
  EXEC_TIMEOUT_MS,
  CONSECUTIVE_TIMEOUT_LIMIT,
  STALE_SESSION_CLOSE_TIMEOUT_MS,
  AGENT_BROWSER_CLEANUP_TIMEOUT_MS
} from './agent-browser-command-constants'
export type SessionState = {
  proxy: CdpWsProxy
  cdpEndpoint: string
  initialized: boolean
  consecutiveTimeouts: number
  activeInterceptPatterns: string[]
  activeCapture: boolean
  lastCommandAt: number
  webContentsId: number
  activeProcess: ChildProcess | null
}

export type AgentBrowserCleanupOptions = { closeTimeoutMs?: number }

export type AgentBrowserExecOptions = {
  envOverrides?: NodeJS.ProcessEnv
  timeoutMs?: number
  timeoutError?: Error
  stdinText?: string
}

export type AgentBrowserSessionTargetPorts = {
  sessions: Map<string, SessionState>
  commandQueues: Map<
    string,
    {
      execute: () => Promise<unknown>
      resolve: (value: unknown) => void
      reject: (error: unknown) => void
    }[]
  >
  processingQueues: Set<string>
  cancelledProcesses: WeakSet<ChildProcess>
  agentBrowserBin: string
  agentBrowserEnv: NodeJS.ProcessEnv
  agentBrowserIdleTimeoutMs: number | null
  pendingInterceptRestore: Map<string, string[]>
  isShutdownStarted(): boolean
  getWebContents(webContentsId: number): Electron.WebContents | null
  execFile: typeof execFile
  CdpWsProxy: typeof CdpWsProxy
}

/**
 * Session-target plumbing for the agent-browser bridge: per-page daemon session lifecycle,
 * command queueing, and the raw agent-browser process transport.
 */
export class AgentBrowserSessionTargets {
  // Promise-locks shared with the bridge so sweep/destroy see in-flight sessions.
  readonly pendingSessionCreation = new Map<string, Promise<void>>()
  readonly pendingSessionDestruction = new Map<string, Promise<void>>()

  constructor(private readonly ports: AgentBrowserSessionTargetPorts) {}

  createPageUnavailableError(sessionName: string): BrowserError {
    return new BrowserError('browser_tab_not_found', pageUnavailableMessageForSession(sessionName))
  }

  assertCommandAdmission(): void {
    if (this.ports.isShutdownStarted()) {
      throw new BrowserError('browser_owner_unavailable', 'Browser runtime is shutting down')
    }
  }

  async ensureSession(
    sessionName: string,
    browserPageId: string,
    webContentsId: number
  ): Promise<void> {
    const pendingDestruction = this.pendingSessionDestruction.get(sessionName)
    if (pendingDestruction) {
      await pendingDestruction
    }
    this.assertCommandAdmission()

    if (this.ports.sessions.has(sessionName)) {
      return
    }

    // Why: without this lock, two concurrent calls both create proxies and the second leaks the first's server/debugger.
    const pending = this.pendingSessionCreation.get(sessionName)
    if (pending) {
      await pending
      this.assertCommandAdmission()
      return
    }

    const createSession = async (): Promise<void> => {
      const wc = this.ports.getWebContents(webContentsId)
      if (!wc) {
        // Why: the webview can be destroyed between target resolution and session creation — keep the same closed-tab error shape.
        throw new BrowserError(
          'browser_tab_not_found',
          `Browser page ${browserPageId} is no longer available`
        )
      }

      // Why: the daemon persists sessions (incl. CDP port) across restarts; close the stale one first or it ignores --cdp and hits the dead port.
      await this.closeStaleAgentBrowserSession(sessionName)

      const proxy = new this.ports.CdpWsProxy(wc)
      const cdpEndpoint = await proxy.start()

      this.ports.sessions.set(sessionName, {
        proxy,
        cdpEndpoint,
        initialized: false,
        consecutiveTimeouts: 0,
        activeInterceptPatterns: [],
        activeCapture: false,
        lastCommandAt: Date.now(),
        webContentsId,
        activeProcess: null
      })
    }

    const promise = createSession()
    this.pendingSessionCreation.set(sessionName, promise)
    try {
      await promise
    } finally {
      this.pendingSessionCreation.delete(sessionName)
    }
  }

  async restartSessionForTarget(
    sessionName: string,
    browserPageId: string,
    webContentsId: number,
    options: { recreate: boolean } = { recreate: true }
  ): Promise<void> {
    const pendingCreation = this.pendingSessionCreation.get(sessionName)
    if (pendingCreation) {
      await pendingCreation.catch(() => {})
    }

    const session = this.ports.sessions.get(sessionName)
    if (session) {
      if (session.activeInterceptPatterns.length > 0) {
        this.ports.pendingInterceptRestore.set(sessionName, [...session.activeInterceptPatterns])
      }
      this.ports.sessions.delete(sessionName)
      this.pendingSessionCreation.delete(sessionName)
      if (session.activeProcess) {
        this.ports.cancelledProcesses.add(session.activeProcess)
        try {
          session.activeProcess.kill()
        } catch {
          // Process may already be exiting.
        }
        session.activeProcess = null
      }

      const destroy = (async (): Promise<void> => {
        try {
          await this.runAgentBrowserRaw(sessionName, ['--session', sessionName, 'close'], {
            timeoutMs: AGENT_BROWSER_CLEANUP_TIMEOUT_MS
          })
        } catch {
          // Session may already be dead.
        }
        await session.proxy.stop()
      })()
      this.pendingSessionDestruction.set(sessionName, destroy)
      try {
        await destroy
      } finally {
        this.pendingSessionDestruction.delete(sessionName)
      }
    }

    if (options.recreate) {
      await this.ensureSession(sessionName, browserPageId, webContentsId)
    }
  }

  async destroySession(
    sessionName: string,
    options: { closeTimeoutMs?: number } = { closeTimeoutMs: AGENT_BROWSER_CLEANUP_TIMEOUT_MS }
  ): Promise<void> {
    const pendingDestruction = this.pendingSessionDestruction.get(sessionName)
    if (pendingDestruction) {
      await pendingDestruction
      return
    }

    const pendingCreation = this.pendingSessionCreation.get(sessionName)
    if (pendingCreation) {
      // Why: tab close can race session creation before sessions.set(); await it so no late proxy survives the close.
      try {
        await pendingCreation
      } catch {
        // Creation failures are handled by the original caller; teardown still rejects queued work below.
      }
    }

    const session = this.ports.sessions.get(sessionName)
    if (!session) {
      this.rejectQueuedCommandsForClosedSession(sessionName)
      return
    }

    this.ports.sessions.delete(sessionName)
    this.pendingSessionCreation.delete(sessionName)

    // Why: queued commands would hang forever if we just delete the queue — drain and reject them.
    this.rejectQueuedCommandsForClosedSession(sessionName)

    if (session.activeProcess) {
      // Why: rejecting the queue isn't enough for an in-flight command — kill the process so callers don't wait out the exec timeout.
      this.ports.cancelledProcesses.add(session.activeProcess)
      try {
        session.activeProcess.kill()
      } catch {
        // Process may already be exiting.
      }
      session.activeProcess = null
    }

    const destroy = (async (): Promise<void> => {
      try {
        // Why: each tab has its own named session — close without --session leaves this tab's daemon running.
        // Why bounded: this runs inside the 20s will-quit barrier, so it cannot inherit the 90s exec timeout.
        await this.runAgentBrowserRaw(
          sessionName,
          ['--session', sessionName, 'close'],
          options.closeTimeoutMs === undefined ? undefined : { timeoutMs: options.closeTimeoutMs }
        )
      } catch {
        // Session may already be dead
      }

      await session.proxy.stop()
    })()
    this.pendingSessionDestruction.set(sessionName, destroy)
    try {
      await destroy
    } finally {
      this.pendingSessionDestruction.delete(sessionName)
    }
  }

  private rejectQueuedCommandsForClosedSession(sessionName: string): void {
    const queue = this.ports.commandQueues.get(sessionName)
    this.ports.commandQueues.delete(sessionName)
    this.ports.processingQueues.delete(sessionName)
    if (queue) {
      const err = new BrowserError(
        'browser_tab_closed',
        'Tab was closed while commands were queued'
      )
      for (const cmd of queue) {
        cmd.reject(err)
      }
      queue.length = 0
    }
  }

  /**
   * Notice that the daemon retired itself between two commands.
   *
   * A replacement daemon still serves the page (every call reasserts `--cdp`)
   * but carries none of the session's network routes, so without this the
   * interception the caller configured is silently gone (#16367).
   */
  reinitializeIfDaemonIdledOut(sessionName: string, session: SessionState): void {
    if (
      this.ports.agentBrowserIdleTimeoutMs === null ||
      Date.now() - session.lastCommandAt < this.ports.agentBrowserIdleTimeoutMs
    ) {
      return
    }
    session.initialized = false
    if (session.activeInterceptPatterns.length > 0) {
      this.ports.pendingInterceptRestore.set(sessionName, [...session.activeInterceptPatterns])
    }
  }

  async execAgentBrowser(
    sessionName: string,
    commandArgs: string[],
    execOptions?: AgentBrowserExecOptions
  ): Promise<unknown> {
    const session = this.ports.sessions.get(sessionName)
    if (!session) {
      // Why: a queued command can run after a concurrent close deleted the session — surface a tab-lifecycle error, not an opaque failure.
      throw this.createPageUnavailableError(sessionName)
    }

    // Why: the webContents can be destroyed during queue delay — check here to avoid cryptic Electron debugger errors.
    if (!this.ports.getWebContents(session.webContentsId)) {
      await this.destroySession(sessionName)
      throw this.createPageUnavailableError(sessionName)
    }

    this.reinitializeIfDaemonIdledOut(sessionName, session)
    session.lastCommandAt = Date.now()

    const args = ['--session', sessionName]
    const managesInterceptRoutes =
      commandArgs[0] === 'network' && (commandArgs[1] === 'route' || commandArgs[1] === 'unroute')

    const needsInit = !session.initialized
    // Why: a restarted named daemon auto-launches Chrome unless every invocation reasserts Orca's CDP owner.
    args.push('--cdp', String(session.proxy.getPort()))

    // Why: exec passthrough can produce a large argv; spreading into push risks V8 argument limits.
    for (const commandArg of commandArgs) {
      args.push(commandArg)
    }
    args.push('--json')

    const stdout = await this.runAgentBrowserRaw(sessionName, args, execOptions)
    const translated = translateResult(stdout)

    if (!translated.ok) {
      throw this.createCommandError(
        sessionName,
        translated.error.message,
        translated.error.code,
        session.webContentsId
      )
    }

    // Why: mark initialized only after success, so a failed first --cdp connection retries with --cdp.
    if (needsInit) {
      session.initialized = true

      // Why: a process swap loses intercept patterns — restore them now unless the caller's first command reconfigured routing.
      const pendingPatterns = managesInterceptRoutes
        ? undefined
        : this.ports.pendingInterceptRestore.get(sessionName)
      if (pendingPatterns && pendingPatterns.length > 0) {
        this.ports.pendingInterceptRestore.delete(sessionName)
        try {
          const urlPattern = pendingPatterns[0] ?? '**/*'
          await this.runAgentBrowserRaw(sessionName, [
            '--session',
            sessionName,
            '--cdp',
            String(session.proxy.getPort()),
            'network',
            'route',
            urlPattern,
            '--json'
          ])
          session.activeInterceptPatterns = pendingPatterns
        } catch {
          // Why: intercept restore is best-effort — don't fail the user's command if the new page can't support it.
        }
      }
    }

    return translated.result
  }

  createCommandError(
    sessionName: string,
    message: string,
    fallbackCode: string,
    webContentsId?: number
  ): BrowserError {
    // Why: CDP "connection refused" can also mean a real proxy failure — only map to closed-page when the target is confirmed gone.
    if (
      fallbackCode === 'browser_error' &&
      isTabClosedTransportError(message) &&
      this.isSessionTargetClosed(sessionName, webContentsId)
    ) {
      return this.createPageUnavailableError(sessionName)
    }
    return new BrowserError(fallbackCode, message)
  }

  private isSessionTargetClosed(sessionName: string, webContentsId?: number): boolean {
    const session = this.ports.sessions.get(sessionName)
    if (!session) {
      return true
    }
    const targetWebContentsId = webContentsId ?? session.webContentsId
    return !this.ports.getWebContents(targetWebContentsId)
  }

  runAgentBrowserRaw(
    sessionName: string,
    args: string[],
    execOptions?: AgentBrowserExecOptions
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const session = this.ports.sessions.get(sessionName)
      let child: ChildProcess | null = null
      child = execFile(
        this.ports.agentBrowserBin,
        args,
        // Why: screenshots return large base64 that exceeds Node's default 1MB maxBuffer (ENOBUFS).
        {
          timeout: execOptions?.timeoutMs ?? EXEC_TIMEOUT_MS,
          maxBuffer: 50 * 1024 * 1024,
          // Why windowsHide: see the stale-session close above -- every
          // agent-browser invocation would otherwise flash a console (#14543).
          windowsHide: true,
          env: execOptions?.envOverrides
            ? { ...this.ports.agentBrowserEnv, ...execOptions.envOverrides }
            : this.ports.agentBrowserEnv
        },
        (error, stdout, stderr) => {
          if (session && session.activeProcess === child) {
            session.activeProcess = null
          }
          if (child && this.ports.cancelledProcesses.has(child)) {
            this.ports.cancelledProcesses.delete(child)
            reject(
              new BrowserError('browser_tab_closed', 'Tab was closed while command was running')
            )
            return
          }

          const liveSession = this.ports.sessions.get(sessionName)

          if (error && (error as NodeJS.ErrnoException & { killed?: boolean }).killed) {
            if (execOptions?.timeoutError) {
              reject(execOptions.timeoutError)
              return
            }
            if (liveSession) {
              liveSession.consecutiveTimeouts++
              if (liveSession.consecutiveTimeouts >= CONSECUTIVE_TIMEOUT_LIMIT) {
                // Why: 3 consecutive timeouts means the daemon is likely stuck — destroy and recreate
                void this.destroySession(sessionName)
              }
            }
            reject(new BrowserError('browser_error', 'Browser command timed out'))
            return
          }

          if (liveSession) {
            liveSession.consecutiveTimeouts = 0
          }

          if (error) {
            // Why: agent-browser exits non-zero on failure but still writes structured JSON to stdout — parse it for the real error.
            if (stdout) {
              try {
                const parsed = JSON.parse(stdout)
                if (parsed.error) {
                  const code = classifyErrorCode(parsed.error)
                  reject(
                    this.createCommandError(sessionName, parsed.error, code, session?.webContentsId)
                  )
                  return
                }
              } catch {
                // stdout not valid JSON — fall through to stderr/error.message
              }
            }
            const message = stderr || error.message
            const code = classifyErrorCode(message)
            reject(this.createCommandError(sessionName, message, code, session?.webContentsId))
            return
          }

          resolve(stdout)
        }
      )
      if (session) {
        session.activeProcess = child
      }
      if (execOptions?.stdinText !== undefined && child?.stdin) {
        // Why: eval --stdin keeps paste-sized scripts out of argv on every platform.
        child.stdin.on('error', () => {})
        child.stdin.end(execOptions.stdinText)
      }
    })
  }

  closeStaleAgentBrowserSession(sessionName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof execFile> | null = null
      let settled = false

      const finish = (error?: Error): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      }

      // Why: proceeding after an unverified close can reuse a daemon that owns an unrelated browser.
      const timeout = setTimeout(() => {
        child?.kill()
        finish(
          new BrowserError(
            'browser_owner_unavailable',
            `Could not reset stale helper session ${sessionName}; retry after agent-browser exits`
          )
        )
      }, STALE_SESSION_CLOSE_TIMEOUT_MS)

      try {
        child = this.ports.execFile(
          this.ports.agentBrowserBin,
          ['--session', sessionName, 'close'],
          // Why windowsHide: agent-browser is console-subsystem and Orca's main
          // process owns no console, so each spawn gets a fresh visible conhost
          // that takes foreground -- keystrokes typed into a terminal at that
          // moment land in the black box (#14543).
          {
            env: this.ports.agentBrowserEnv,
            timeout: STALE_SESSION_CLOSE_TIMEOUT_MS,
            windowsHide: true
          },
          (error) =>
            finish(
              error
                ? new BrowserError(
                    'browser_owner_unavailable',
                    `Could not reset stale helper session ${sessionName}: ${error.message}`
                  )
                : undefined
            )
        )
      } catch (error) {
        finish(
          new BrowserError(
            'browser_owner_unavailable',
            `Could not reset stale helper session ${sessionName}: ${error instanceof Error ? error.message : String(error)}`
          )
        )
      }
    })
  }
}
