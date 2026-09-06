import type { RequestContext } from './dispatcher'
import type { PtySourceReceivingActivation } from '../shared/pty-source-receiving-activation'

export type RelayAgentSessionCreateResult = {
  id: string
  incarnationId: string
  replay?: string
  agentSessionEnsure?: unknown
  sourceActivation?: PtySourceReceivingActivation
}

const AGENT_SESSION_CREATE_OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/
const AGENT_SESSION_CREATE_OPERATION_RETENTION_MS = 24 * 60 * 60 * 1000
const AGENT_SESSION_CREATE_OPERATION_LIMIT = 4_096

/** Owns the `agentSessionCreateOperationId` dedupe ledger for `pty.spawn`: replays an in-flight
 *  create for a duplicate operation id, retires completed operations on a retention timer, and
 *  keeps an `outcome: unknown` failure parked so a retry replays the failure instead of spawning
 *  a second PTY over the same claim. */
export class PtyAgentSessionCreateOperations {
  private readonly operations = new Map<string, Promise<RelayAgentSessionCreateResult>>()

  /** Begin the operation: returns an existing in-flight promise, or null when the caller must run
   *  the create itself and hand its promise back via {@link track}. */
  claim(
    operationId: unknown,
    context: RequestContext | undefined,
    spawnOnce: () => Promise<RelayAgentSessionCreateResult>,
    adopt: (
      result: RelayAgentSessionCreateResult,
      context?: RequestContext
    ) => RelayAgentSessionCreateResult
  ): Promise<RelayAgentSessionCreateResult> {
    if (operationId === undefined) {
      return spawnOnce()
    }
    if (
      typeof operationId !== 'string' ||
      !AGENT_SESSION_CREATE_OPERATION_ID_PATTERN.test(operationId)
    ) {
      throw new Error('agent_session_operation_invalid')
    }
    const existing = this.operations.get(operationId)
    if (existing) {
      return existing.then((result) => adopt(result, context))
    }
    if (this.operations.size >= AGENT_SESSION_CREATE_OPERATION_LIMIT) {
      throw new Error('agent_session_operation_capacity')
    }
    const operation = spawnOnce()
    this.operations.set(operationId, operation)
    return operation.then(
      (result) => {
        this.expire(operationId, operation)
        return result
      },
      (error: unknown) => {
        const outcomeUnknown =
          typeof error === 'object' &&
          error !== null &&
          'agentSessionOperationOutcome' in error &&
          error.agentSessionOperationOutcome === 'unknown'
        if (outcomeUnknown) {
          // Why: the native PTY may be live; replay the same failure instead of spawning again.
          this.expire(operationId, operation)
        } else if (this.operations.get(operationId) === operation) {
          this.operations.delete(operationId)
        }
        throw error
      }
    )
  }

  private expire(operationId: string, operation: Promise<RelayAgentSessionCreateResult>): void {
    const timer = setTimeout(() => {
      if (this.operations.get(operationId) === operation) {
        this.operations.delete(operationId)
      }
    }, AGENT_SESSION_CREATE_OPERATION_RETENTION_MS)
    timer.unref?.()
  }

  clear(): void {
    this.operations.clear()
  }
}
