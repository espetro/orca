import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { join } from 'node:path'

import {
  getEndpointFileName,
  writeEndpointFile
} from '../../shared/agent-hook-listener/endpoint-publication'
import { HOOK_REQUEST_SLOWLORIS_MS } from '../../shared/agent-hook-listener/listener-limits'
import {
  ORCA_HOOK_PROTOCOL_VERSION,
  ORCA_HOOK_RAW_JSON_TRANSPORT
} from '../../shared/agent-hook-types'
import { mergeAgentHookRequestHeaders } from '../../shared/agent-hook-listener/hook-envelope'
import { readRequestBody } from '../../shared/agent-hook-listener/request-body'
import { resolveHookSource } from '../../shared/agent-hook-listener/source-routing'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import type { AgentHookSource } from '../../shared/agent-hook-relay'
import {
  isHookRequestTruncatedError,
  type HookTransportInterferenceTracker
} from '../../shared/agent-hook-transport-interference'
import type { AgentStatusObservationSequencer } from '../../shared/agent-status-observation'
import {
  CLAUDE_STATUSLINE_PATHNAME,
  parseClaudeStatusLineBody,
  type ClaudeStatusLineRateLimits
} from '../../shared/claude-statusline-rate-limits'
import {
  trackEmptyPaneKeyHook,
  type EnrichedAgentHookEventPayload,
  type NormalizedLocalHook
} from './agent-hook-payload-sanitize'
import type { AgentStatusDisposition } from './pane-authority-transfer'

export type AgentHookHttpServerDeps = {
  token: string
  onClaudeStatusLine: ((event: ClaudeStatusLineRateLimits) => void) | null
  endpointDir: string | null
  endpointFilePathCache: string | null
  endpointFileWritten: boolean
  env: string
  transportInterference: HookTransportInterferenceTracker
  observations: Pick<AgentStatusObservationSequencer, 'rebind'>
  normalizeHookBodyPaneKeyAlias(body: unknown): unknown
  normalizeLocalHookPayload(source: AgentHookSource, body: unknown): NormalizedLocalHook
  getAgentStatusDisposition(
    paneKey: string,
    options?: {
      hookEventName?: string
      isReplay?: boolean
      source?: AgentHookSource
      hasExplicitPrompt?: boolean
      launchToken?: string
    }
  ): AgentStatusDisposition
  recordCurrentAuthorityObservation(payload: AgentHookEventPayload): void
  applyNormalizedStatus(
    payload: AgentHookEventPayload,
    onAccepted?: () => void
  ): EnrichedAgentHookEventPayload
  scheduleAssistantMessageRetry(
    source: AgentHookSource,
    body: unknown,
    original: EnrichedAgentHookEventPayload,
    attempt?: number,
    discoveryReady?: boolean
  ): void
  scheduleCodexSubagentPoll(
    source: AgentHookSource,
    body: unknown,
    original: EnrichedAgentHookEventPayload
  ): void
  maybeWriteEndpointFile(): void
}

export type AgentHookEndpointState = {
  endpointDir: string | null
  endpointFilePathCache: string | null
  endpointFileWritten: boolean
  env: string
}

// Why: owns the loopback HTTP adapter — request handling, slowloris cap, and listen handshake —
// so server.ts keeps pipeline state next to the surfaces that mutate it.
export class AgentHookHttpServer {
  private server: Server | null = null
  private boundPort = 0

  constructor(private readonly deps: AgentHookHttpServerDeps) {}

  /** Why: token rotates on start(); held here so auth check and buildPtyEnv agree after restart. */
  setToken(token: string): void {
    this.deps.token = token
  }

  configureEndpoint(options: { userDataPath: string; endpointNamespace?: string }): void {
    this.deps.endpointDir = options.endpointNamespace
      ? join(options.userDataPath, 'agent-hooks', options.endpointNamespace)
      : join(options.userDataPath, 'agent-hooks')
    this.deps.endpointFilePathCache = join(this.deps.endpointDir, getEndpointFileName())
  }

  clearEndpointState(): void {
    this.deps.endpointDir = null
    this.deps.endpointFilePathCache = null
    this.deps.endpointFileWritten = false
  }

  get endpointFilePath(): string | null {
    return this.deps.endpointFilePathCache
  }

  get endpointDir(): string | null {
    return this.deps.endpointDir
  }

  get env(): string {
    return this.deps.env
  }

  set env(value: string) {
    this.deps.env = value
  }

  get token(): string {
    return this.deps.token
  }

  writeEndpointFile(): void {
    if (!this.deps.endpointDir || !this.deps.endpointFilePathCache) {
      return
    }
    this.deps.endpointFileWritten = false
    const ok = writeEndpointFile(this.deps.endpointDir, this.deps.endpointFilePathCache, {
      port: this.boundPort,
      token: this.deps.token,
      env: this.deps.env,
      version: ORCA_HOOK_PROTOCOL_VERSION,
      transport: ORCA_HOOK_RAW_JSON_TRANSPORT
    })
    this.deps.endpointFileWritten = ok
  }

  buildPtyEnv(): Record<string, string> {
    if (this.boundPort <= 0 || !this.deps.token) {
      return {}
    }

    const env: Record<string, string> = {
      ORCA_AGENT_HOOK_PORT: String(this.boundPort),
      ORCA_AGENT_HOOK_TOKEN: this.deps.token,
      ORCA_AGENT_HOOK_ENV: this.deps.env,
      ORCA_AGENT_HOOK_VERSION: ORCA_HOOK_PROTOCOL_VERSION,
      ORCA_AGENT_HOOK_TRANSPORT: ORCA_HOOK_RAW_JSON_TRANSPORT
    }
    // Why: hooks source this file at invocation; dev namespaces it so parallel `pnpm dev` runs don't steal each other's hooks.
    if (this.deps.endpointFileWritten && this.deps.endpointFilePathCache) {
      env.ORCA_AGENT_HOOK_ENDPOINT = this.deps.endpointFilePathCache
    }
    return env
  }

  get running(): boolean {
    return this.server !== null
  }

  get port(): number {
    return this.boundPort
  }

  async start(): Promise<void> {
    // Why: node ignores a returned promise, so the handler must settle it itself; handleRequest never rejects.
    this.server = createServer((req, res) => {
      void this.handleRequest(req, res)
    })

    await new Promise<void>((resolve, reject) => {
      // Why: swap the startup reject-handler for a logging one so a later runtime 'error' can't crash main as an unhandled event.
      const onStartupError = (err: Error): void => {
        this.server?.off('listening', onListening)
        reject(err)
      }
      const onListening = (): void => {
        this.server?.off('error', onStartupError)
        this.server?.on('error', (err) => {
          console.error('[agent-hooks] server error', err)
        })
        const address = this.server!.address()
        if (address && typeof address === 'object') {
          this.boundPort = address.port
        }
        this.deps.maybeWriteEndpointFile()
        resolve()
      }
      this.server!.once('error', onStartupError)
      this.server!.listen(0, '127.0.0.1', onListening)
    })
  }

  close(): void {
    this.server?.close()
    this.server = null
    this.boundPort = 0
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(404)
      res.end()
      return
    }

    if (req.headers['x-orca-agent-hook-token'] !== this.deps.token) {
      res.writeHead(403)
      res.end()
      return
    }

    // Why: bound request time so a stalled client can't hold a socket open (slowloris).
    // Why: track our own destroy so the slowloris cap can't be misread as outside interference.
    let destroyedBySlowlorisCap = false
    req.setTimeout(HOOK_REQUEST_SLOWLORIS_MS, () => {
      destroyedBySlowlorisCap = true
      req.destroy()
    })

    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    try {
      const body = await readRequestBody(req)
      if (pathname === CLAUDE_STATUSLINE_PATHNAME) {
        const statusLineEvent = parseClaudeStatusLineBody(body)
        if (statusLineEvent) {
          this.deps.onClaudeStatusLine?.(statusLineEvent)
        }
        res.writeHead(204)
        res.end()
        return
      }
      const source = resolveHookSource(pathname)
      if (!source) {
        res.writeHead(404)
        res.end()
        return
      }

      const hookBody = mergeAgentHookRequestHeaders(body, req.headers)
      trackEmptyPaneKeyHook(hookBody)
      const aliasedBody = this.deps.normalizeHookBodyPaneKeyAlias(hookBody)
      const normalized = this.deps.normalizeLocalHookPayload(source, aliasedBody)
      const statusDisposition = normalized.event
        ? this.deps.getAgentStatusDisposition(normalized.event.paneKey, {
            source,
            hookEventName: normalized.event.hookEventName,
            isReplay: normalized.event.isReplay,
            hasExplicitPrompt: normalized.event.hasExplicitPrompt,
            launchToken: normalized.event.launchToken
          })
        : 'suppress'
      if (normalized.event && statusDisposition !== 'suppress') {
        const event =
          statusDisposition === 'restart'
            ? { ...normalized.event, launchToken: undefined }
            : normalized.event
        if (statusDisposition === 'restart') {
          // Why: a retired pane accepting a new turn is a different agent session behind the
          // same key — later observations must not be ordered against the retired one.
          this.deps.observations.rebind(event.paneKey)
        }
        this.deps.recordCurrentAuthorityObservation(event)
        const enriched = this.deps.applyNormalizedStatus(event, normalized.onAccepted)
        this.deps.scheduleAssistantMessageRetry(source, aliasedBody, enriched)
        this.deps.scheduleCodexSubagentPoll(source, aliasedBody, enriched)
      }

      res.writeHead(204)
      res.end()
    } catch (error) {
      // Why (#11217): an authenticated POST whose body dies short of its own Content-Length was cut
      // by something on the loopback path, not by a bad payload. Fail open as before, but count it —
      // this is the one failure mode that silently stops status for every runtime at once.
      if (isHookRequestTruncatedError(error) && !destroyedBySlowlorisCap) {
        this.deps.transportInterference.record({ source: resolveHookSource(pathname) ?? null, error })
      }
      // Why: fail open — return success on malformed payloads so a broken hook never blocks the agent.
      res.writeHead(204)
      res.end()
    }
  }
}
