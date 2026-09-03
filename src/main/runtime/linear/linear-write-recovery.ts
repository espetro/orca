import type {
} from '../../../shared/linear/agent-access'


import type {
  getAttachmentByUuidForAgent as getLinearAttachmentByUuidForAgent,
  getCommentByUuidForAgent as getLinearCommentByUuidForAgent,
  getIssueByUuidForAgent as getLinearIssueByUuidForAgent,
} from '../../linear/linear-issue-lookups'
import {
  LinearAgentAccessError,
} from '../../linear/issue-context'
import {
  linearError,
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

export class LinearWriteRecovery {
  constructor(private readonly host: RuntimeLinearCommandHost) {}

async getMatchingLinearCommentWrite(
  writeId: string,
  issueId: string,
  parentId: string | null,
  workspaceId: string,
  required: boolean
): Promise<Awaited<ReturnType<typeof getLinearCommentByUuidForAgent>> | null> {
  const comment = await this.readLinearWriteLookup(() =>
    getLinearCommentByUuidForAgent(writeId, workspaceId)
  )
  if (!comment) {
    return null
  }
  if (comment.issue.id === issueId && comment.parentId === parentId) {
    return comment
  }
  if (required) {
    throw linearError(
      'linear_invalid_write_id',
      'The write id belongs to a different comment target.'
    )
  }
  return null
}

async getMatchingLinearAttachmentWrite(
  writeId: string,
  issueId: string,
  workspaceId: string,
  required: boolean
): Promise<Awaited<ReturnType<typeof getLinearAttachmentByUuidForAgent>> | null> {
  const attachment = await this.readLinearWriteLookup(() =>
    getLinearAttachmentByUuidForAgent(writeId, workspaceId)
  )
  if (!attachment) {
    return null
  }
  if (attachment.issue.id === issueId) {
    return attachment
  }
  if (required) {
    throw linearError(
      'linear_invalid_write_id',
      'The write id belongs to a different attachment target.'
    )
  }
  return null
}

async getMatchingLinearCreatedIssue(
  writeId: string,
  teamId: string,
  parentId: string | null,
  workspaceId: string,
  required: boolean,
  intent: LinearCreateFieldIntent = {}
): Promise<Awaited<ReturnType<typeof getLinearIssueByUuidForAgent>> | null> {
  const issue = await this.readLinearWriteLookup(() =>
    getLinearIssueByUuidForAgent(writeId, workspaceId)
  )
  if (!issue) {
    return null
  }
  if (
    issue.team.id === teamId &&
    (issue.parent?.id ?? null) === parentId &&
    this.linearCreatedIssueMatchesIntent(issue, intent)
  ) {
    return issue
  }
  if (required) {
    throw linearError(
      'linear_invalid_write_id',
      'The write id belongs to a different issue target.'
    )
  }
  return null
}

async refetchLinearCommentAfterDuplicate(
  writeId: string,
  issueId: string,
  parentId: string | null,
  workspaceId: string,
  unconfirmed: (cause?: string) => LinearAgentAccessError
): Promise<NonNullable<Awaited<ReturnType<typeof getLinearCommentByUuidForAgent>>>> {
  try {
    // Why: a duplicate-id response can mean the original write landed; only the exact target relationship proves this pinned retry.
    const comment = await this.getMatchingLinearCommentWrite(
      writeId,
      issueId,
      parentId,
      workspaceId,
      true
    )
    if (comment) {
      return comment
    }
  } catch (error) {
    if (error instanceof LinearAgentAccessError && error.code === 'linear_invalid_write_id') {
      throw error
    }
    throw unconfirmed(
      error instanceof Error
        ? sanitizeLinearErrorMessage(error.message)
        : sanitizeLinearErrorMessage(String(error))
    )
  }
  throw unconfirmed()
}

async refetchLinearAttachmentAfterDuplicate(
  writeId: string,
  issueId: string,
  workspaceId: string,
  unconfirmed: (cause?: string) => LinearAgentAccessError
): Promise<NonNullable<Awaited<ReturnType<typeof getLinearAttachmentByUuidForAgent>>>> {
  try {
    // Why: a duplicate-id response can mean the original write landed; only the exact target relationship proves this pinned retry.
    const attachment = await this.getMatchingLinearAttachmentWrite(
      writeId,
      issueId,
      workspaceId,
      true
    )
    if (attachment) {
      return attachment
    }
  } catch (error) {
    if (error instanceof LinearAgentAccessError && error.code === 'linear_invalid_write_id') {
      throw error
    }
    throw unconfirmed(
      error instanceof Error
        ? sanitizeLinearErrorMessage(error.message)
        : sanitizeLinearErrorMessage(String(error))
    )
  }
  throw unconfirmed()
}

async refetchLinearIssueAfterDuplicate(
  writeId: string,
  teamId: string,
  parentId: string | null,
  workspaceId: string,
  intent: LinearCreateFieldIntent,
  unconfirmed: (cause?: string) => LinearAgentAccessError
): Promise<NonNullable<Awaited<ReturnType<typeof getLinearIssueByUuidForAgent>>>> {
  try {
    // Why: a duplicate-id response can mean the original write landed; only the exact target relationship proves this pinned retry.
    const issue = await this.getMatchingLinearCreatedIssue(
      writeId,
      teamId,
      parentId,
      workspaceId,
      true,
      intent
    )
    if (issue) {
      return issue
    }
  } catch (error) {
    if (error instanceof LinearAgentAccessError && error.code === 'linear_invalid_write_id') {
      throw error
    }
    throw unconfirmed(
      error instanceof Error
        ? sanitizeLinearErrorMessage(error.message)
        : sanitizeLinearErrorMessage(String(error))
    )
  }
  throw unconfirmed()
}

parseLinearAttachmentUrl(value: string): URL {
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url
    }
  } catch {
    // Fall through to the stable agent-facing error below.
  }
  throw linearError('linear_invalid_url', 'Attachment URL must be an absolute http(s) URL.')
}

defaultLinearAttachmentTitle(url: URL): string {
  const tail = url.pathname.split('/').findLast(Boolean)
  return tail ? `${url.host}/${tail}` : url.host
}

linearCreateStyleUnconfirmed(
  verb: 'comment' | 'attach' | 'create',
  writeId: string,
  target: LinearAgentWriteTarget | null,
  extra: {
    parentId?: string | null
    team?: { id: string; key: string; name: string; workspaceId: string }
    parent?: LinearAgentWriteTarget | null
    title?: string
    url?: string
    bodyRequired?: boolean
    createFields?: LinearCreateFieldIntent
    cause?: string
  } = {}
): LinearAgentAccessError {
  const workspaceId = target?.workspaceId ?? extra.team?.workspaceId ?? ''
  // Why: the retry preserves id and target so duplicate recovery can prove intent without matching mutable content.
  const pinned =
    verb === 'create'
      ? [
          'orca linear create',
          `--workspace=${this.commandToken(workspaceId, 'WORKSPACE_ID')}`,
          `--write-id=${this.commandToken(writeId, 'WRITE_ID')}`,
          '--title TITLE_HERE',
          ...(extra.bodyRequired ? ['--body-file -'] : []),
          ...(extra.parent
            ? [`--parent=${this.commandToken(extra.parent.issue.identifier, 'PARENT_ISSUE')}`]
            : []),
          ...(extra.team
            ? [`--team=${this.commandToken(extra.team.key, 'TEAM_KEY')}`]
            : []
          ).concat(this.linearCreateFieldRetryTokens(extra.createFields))
        ].join(' ')
      : [
          `orca linear ${verb === 'attach' ? 'attach' : 'comment add'}`,
          this.commandToken(target?.issue.identifier ?? '', 'ISSUE_ID'),
          `--workspace=${this.commandToken(workspaceId, 'WORKSPACE_ID')}`,
          `--write-id=${this.commandToken(writeId, 'WRITE_ID')}`,
          ...(verb === 'comment' ? ['--body-file -'] : []),
          ...(verb === 'comment' && extra.parentId
            ? [`--reply-to=${this.commandToken(extra.parentId, 'COMMENT_ID')}`]
            : []),
          ...(verb === 'attach' ? ['--url URL_HERE', '--title TITLE_HERE'] : [])
        ].join(' ')
  const retryPrefix = extra.bodyRequired || verb === 'comment' ? 'Pipe the same body and r' : 'R'
  const payloadNote =
    verb === 'attach'
      ? ' Replace TITLE_HERE/URL_HERE with the exact original payload values before running.'
      : verb === 'create'
        ? ' Replace TITLE_HERE with the exact original title before running.'
        : ''
  return linearError(
    'linear_write_unconfirmed',
    'Linear may have applied the write, but Orca could not confirm it.',
    {
      writeId,
      workspaceId,
      issueIdentifier: target?.issue.identifier,
      parentId: extra.parentId,
      team: extra.team ? { id: extra.team.id, key: extra.team.key } : undefined,
      parentIdentifier: extra.parent?.issue.identifier,
      createFields: extra.createFields,
      nextSteps: [
        `${retryPrefix}etry once with the pinned command: \`${pinned}\`.${payloadNote}`
      ],
      ...(extra.cause ? { cause: sanitizeLinearErrorMessage(extra.cause) } : {})
    }
  )
}
}
