import type {
  LinearAttachResult,
  LinearCommentAddResult,
  LinearCreateResult,
  LinearErrorCode,
} from '../../../shared/linear/agent-access'


import {
  isAuthError as isLinearAuthError,
} from '../../linear/client'
import type {
  getAttachmentByUuidForAgent as getLinearAttachmentByUuidForAgent,
  getCommentByUuidForAgent as getLinearCommentByUuidForAgent,
  getIssueByUuidForAgent as getLinearIssueByUuidForAgent,
} from '../../linear/linear-issue-lookups'
import { LinearWriteFailure } from '../../linear/linear-issue-write-support'
import {
  LinearAgentAccessError,
} from '../../linear/issue-context'
import {
  classifyLinearError,
  linearError,
  linearMessage,
  sanitizeLinearErrorMessage
} from '../../linear/issue-context-errors'

import type { RuntimeLinearCommandHost } from '../runtime-linear-command-host'

type LinearAgentWriteTarget = {
  issue: LinearIssueSummary
  workspaceId: string
}

type LinearCreateFieldIntent = {
  stateId?: string
  assigneeId?: string | null
  priority?: number
  estimate?: number | null
  dueDate?: string | null
  labelIds?: string[]
  projectId?: string
}

export class LinearWriteCore {
  constructor(private readonly host: RuntimeLinearCommandHost) {}

async runLinearAgentWrite<T>(
  write: (signal: AbortSignal) => Promise<T>,
  unconfirmed: (cause?: string) => LinearAgentAccessError
): Promise<T> {
  const controller = new AbortController()
  const writePromise = write(controller.signal)
  writePromise.catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      writePromise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(
            new LinearWriteFailure(
              'unconfirmed',
              'Linear write deadline elapsed before confirmation.'
            )
          )
        }, 25_000)
      })
    ])
  } catch (error) {
    if (error instanceof LinearWriteFailure && error.kind === 'duplicate_id') {
      throw error
    }
    if (error instanceof LinearWriteFailure && error.kind === 'unconfirmed') {
      throw unconfirmed(this.linearWriteFailureCauseMessage(error))
    }
    if (error instanceof LinearWriteFailure && error.kind === 'network') {
      throw linearError('linear_network_error', sanitizeLinearErrorMessage(error.message))
    }
    if (error instanceof LinearWriteFailure) {
      throw linearError('linear_write_failed', sanitizeLinearErrorMessage(error.message))
    }
    throw this.mapLinearReadFailure(error)
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

async readLinearWriteLookup<T>(lookup: () => Promise<T>): Promise<T> {
  try {
    return await lookup()
  } catch (error) {
    throw this.mapLinearReadFailure(error)
  }
}

mapLinearReadFailure(error: unknown): LinearAgentAccessError {
  if (error instanceof LinearAgentAccessError) {
    return error
  }
  if (isLinearAuthError(error)) {
    return linearError('linear_auth_expired', 'Linear authentication expired.', {
      nextSteps: ['Reconnect Linear from Orca settings.']
    })
  }
  return linearError(classifyLinearError(error), linearMessage(error))
}

linearWriteFailureCauseMessage(error: LinearWriteFailure): string {
  if (error.cause instanceof Error) {
    return sanitizeLinearErrorMessage(error.cause.message)
  }
  if (error.cause !== undefined) {
    return sanitizeLinearErrorMessage(String(error.cause))
  }
  return sanitizeLinearErrorMessage(error.message)
}

linearWorkspaceErrorCode(type: string): LinearErrorCode {
  if (type === 'auth') {
    return 'linear_auth_expired'
  }
  if (type === 'network') {
    return 'linear_network_error'
  }
  if (type === 'rate_limited') {
    return 'linear_rate_limited'
  }
  return 'linear_write_failed'
}

linearWriteIssueRef(issue: { id: string; identifier: string; url: string }): {
  id: string
  identifier: string
  url: string
} {
  return { id: issue.id, identifier: issue.identifier, url: issue.url }
}

linearCommentResult(
  comment: NonNullable<Awaited<ReturnType<typeof getLinearCommentByUuidForAgent>>>,
  target: LinearAgentWriteTarget,
  bodyChars: number,
  writeId: string,
  deduplicated: boolean
): LinearCommentAddResult {
  return {
    comment: { id: comment.id, url: comment.url, parentId: comment.parentId },
    issue: this.linearWriteIssueRef(target.issue),
    meta: { workspaceId: target.workspaceId, bodyChars, writeId, deduplicated }
  }
}

linearAttachResult(
  attachment: NonNullable<Awaited<ReturnType<typeof getLinearAttachmentByUuidForAgent>>>,
  target: LinearAgentWriteTarget,
  writeId: string,
  deduplicated: boolean
): LinearAttachResult {
  return {
    attachment: { id: attachment.id, title: attachment.title, url: attachment.url },
    issue: this.linearWriteIssueRef(target.issue),
    meta: { workspaceId: target.workspaceId, writeId, deduplicated }
  }
}

linearCreateResult(
  issue: NonNullable<Awaited<ReturnType<typeof getLinearIssueByUuidForAgent>>>,
  workspaceId: string,
  writeId: string,
  deduplicated: boolean
): LinearCreateResult {
  return {
    issue,
    meta: { workspaceId, writeId, deduplicated }
  }
}

linearCreateFieldRetryTokens(fields: LinearCreateFieldIntent | undefined): string[] {
  if (!fields) {
    return []
  }
  return [
    ...(fields.stateId ? [`--state=${this.commandToken(fields.stateId, 'STATE_ID')}`] : []),
    ...(fields.assigneeId
      ? [`--assignee=${this.commandToken(fields.assigneeId, 'ASSIGNEE_ID')}`]
      : []),
    ...(fields.priority !== undefined
      ? [`--priority=${this.linearPriorityRetryToken(fields.priority)}`]
      : []),
    ...(fields.estimate !== undefined && fields.estimate !== null
      ? [`--estimate=${fields.estimate}`]
      : []),
    ...(fields.dueDate ? [`--due-date=${fields.dueDate}`] : []),
    ...(fields.projectId
      ? [`--project=${this.commandToken(fields.projectId, 'PROJECT_ID')}`]
      : []),
    ...(fields.labelIds ?? []).map(
      (labelId) => `--label=${this.commandToken(labelId, 'LABEL_ID')}`
    )
  ]
}

linearPriorityRetryToken(priority: number): string {
  if (priority === 1) {
    return 'urgent'
  }
  if (priority === 2) {
    return 'high'
  }
  if (priority === 3) {
    return 'medium'
  }
  if (priority === 4) {
    return 'low'
  }
  return 'none'
}

linearTeamSummary(team: {
  id: string
  name: string
  key: string
  url?: string
  workspaceId?: string
  workspaceName?: string
}): {
  id: string
  name: string
  key: string
  url?: string
  workspace?: { id: string; name: string }
} {
  return {
    id: team.id,
    name: team.name,
    key: team.key,
    ...(team.url ? { url: team.url } : {}),
    ...(team.workspaceId
      ? { workspace: { id: team.workspaceId, name: team.workspaceName ?? team.workspaceId } }
      : {})
  }
}

commandToken(value: string, placeholder: string): string {
  return /^[A-Za-z0-9._:@%+=,/-]+$/.test(value) ? value : placeholder
}

async notifyLinearLinkedIssueUpdated(
  workspaceId: string,
  identifier: string | readonly string[]
): Promise<void> {
  const identifiers = typeof identifier === 'string' ? [identifier] : identifier
  const normalized = new Map(
    identifiers.map((value) => [value.toLocaleUpperCase(), value] as const)
  )
  for (const worktree of await this.host.listResolvedWorktrees()) {
    const linkedIdentifier = normalized.get(
      (worktree.linkedLinearIssue ?? '').toLocaleUpperCase()
    )
    if (!linkedIdentifier) {
      continue
    }
    const linkedWorkspaceId = worktree.linkedLinearIssueWorkspaceId ?? workspaceId
    if (linkedWorkspaceId !== workspaceId) {
      continue
    }
    this.host.emitClientEvent({
      type: 'linearLinkedIssueUpdated',
      worktreeId: worktree.id,
      identifier: linkedIdentifier,
      workspaceId
    })
  }
}
}
