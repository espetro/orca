import type { AppState } from '../types'
import type { PersistedTrustedOrcaHooks } from '../../../../shared/orca-yaml-hook-types'
import type { TaskResumeState, TaskViewPresetId } from '../../../../shared/ui-chrome-types'
import type { WorkspaceCleanupDismissal } from '../../../../shared/workspace-cleanup'
import { WORKSPACE_CLEANUP_CLASSIFIER_VERSION } from '../../../../shared/workspace-cleanup'
import { persistedUIValuesEqual } from '../../../../shared/persisted-ui-equality'
import type { UISlice } from './ui'

const MIN_SIDEBAR_WIDTH = 220
const HYDRATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const VALID_TASK_PRESETS = new Set<TaskViewPresetId>([
  'all',
  'issues',
  'my-issues',
  'prs',
  'review',
  'my-prs'
])

const VALID_LINEAR_PRESETS = new Set<NonNullable<TaskResumeState['linearPreset']>>([
  'assigned',
  'created',
  'all',
  'completed'
])

const VALID_LINEAR_MODES = new Set<NonNullable<TaskResumeState['linearMode']>>([
  'issues',
  'projects',
  'views',
  'in-orca'
])

const VALID_JIRA_PRESETS = new Set<NonNullable<TaskResumeState['jiraPreset']>>([
  'assigned',
  'reported',
  'all',
  'done'
])

export function isPlainPersistedRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function sanitizePersistedRepoIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((repoId): repoId is string => typeof repoId === 'string')
}

function sanitizeTrustedOrcaHooks(trust: unknown): PersistedTrustedOrcaHooks {
  if (!isPlainPersistedRecord(trust)) {
    return {}
  }
  const next: PersistedTrustedOrcaHooks = {}
  for (const [repoId, entry] of Object.entries(trust)) {
    if (!isSafePersistedRecordKey(repoId) || !isPlainPersistedRecord(entry)) {
      continue
    }
    next[repoId] = entry as PersistedTrustedOrcaHooks[string]
  }
  return next
}

function filterTrustedOrcaHooksToValidRepos(
  trust: unknown,
  validRepoIds: Set<string>
): PersistedTrustedOrcaHooks {
  const sanitized = sanitizeTrustedOrcaHooks(trust)
  const next: PersistedTrustedOrcaHooks = {}
  for (const [repoId, entry] of Object.entries(sanitized)) {
    if (validRepoIds.has(repoId)) {
      next[repoId] = entry
    }
  }
  return next
}

export function hydrateTrustedOrcaHooks(
  trust: unknown,
  validRepoIds: Set<string>
): PersistedTrustedOrcaHooks {
  const sanitized = sanitizeTrustedOrcaHooks(trust)
  if (validRepoIds.size === 0) {
    return sanitized
  }
  return filterTrustedOrcaHooksToValidRepos(sanitized, validRepoIds)
}

function isSafePersistedRecordKey(key: string): boolean {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype'
}

export function sanitizeShowDotfilesByWorktree(value: unknown): Record<string, boolean> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const out: Record<string, boolean> = {}
  for (const [worktreeId, showDotfiles] of Object.entries(value as Record<string, unknown>)) {
    if (!worktreeId || !isSafePersistedRecordKey(worktreeId) || typeof showDotfiles !== 'boolean') {
      continue
    }
    out[worktreeId] = showDotfiles
  }
  return out
}

export function sanitizePersistedSidebarWidth(
  width: unknown,
  fallback: number,
  maxWidth: number
): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) {
    return fallback
  }
  return Math.min(maxWidth, Math.max(MIN_SIDEBAR_WIDTH, width))
}

// Why: persisted JSON may be tampered/corrupt — reject arrays, prototype-pollution keys, and non-finite values; drop past-TTL entries.
export function sanitizeAcknowledgedAgentsByPaneKey(value: unknown): Record<string, number> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const cutoff = Date.now() - HYDRATE_MAX_AGE_MS
  const out: Record<string, number> = {}
  for (const [key, ackAt] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key !== 'string' || !isSafePersistedRecordKey(key)) {
      continue
    }
    if (typeof ackAt !== 'number' || !Number.isFinite(ackAt) || ackAt <= 0) {
      continue
    }
    if (ackAt < cutoff) {
      continue
    }
    out[key] = ackAt
  }
  return out
}

export function sanitizeWorkspaceCleanupDismissals(
  value: unknown
): Record<string, WorkspaceCleanupDismissal> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const out: Record<string, WorkspaceCleanupDismissal> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      continue
    }
    const input = raw as Record<string, unknown>
    if (
      typeof input.worktreeId !== 'string' ||
      typeof input.dismissedAt !== 'number' ||
      !Number.isFinite(input.dismissedAt) ||
      typeof input.fingerprint !== 'string' ||
      input.classifierVersion !== WORKSPACE_CLEANUP_CLASSIFIER_VERSION
    ) {
      continue
    }
    out[key] = {
      worktreeId: input.worktreeId,
      dismissedAt: input.dismissedAt,
      fingerprint: input.fingerprint,
      classifierVersion: input.classifierVersion
    }
  }
  return out
}

export function sanitizeTaskResumeState(value: unknown): TaskResumeState | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const input = value as Record<string, unknown>
  const next: TaskResumeState = {}

  if (input.githubMode === 'items' || input.githubMode === 'project') {
    next.githubMode = input.githubMode
  }
  if (input.githubItemsPreset === null) {
    next.githubItemsPreset = null
  } else if (typeof input.githubItemsPreset === 'string') {
    if (VALID_TASK_PRESETS.has(input.githubItemsPreset as TaskViewPresetId)) {
      next.githubItemsPreset = input.githubItemsPreset as TaskViewPresetId
    }
  }
  if (typeof input.githubItemsQuery === 'string') {
    next.githubItemsQuery = input.githubItemsQuery
  }
  if (
    typeof input.linearPreset === 'string' &&
    VALID_LINEAR_PRESETS.has(input.linearPreset as NonNullable<TaskResumeState['linearPreset']>)
  ) {
    next.linearPreset = input.linearPreset as NonNullable<TaskResumeState['linearPreset']>
  }
  if (
    typeof input.linearMode === 'string' &&
    VALID_LINEAR_MODES.has(input.linearMode as NonNullable<TaskResumeState['linearMode']>)
  ) {
    next.linearMode = input.linearMode as NonNullable<TaskResumeState['linearMode']>
  }
  if (typeof input.linearQuery === 'string') {
    next.linearQuery = input.linearQuery
  }
  if (input.linearContext && typeof input.linearContext === 'object') {
    const context = input.linearContext as Record<string, unknown>
    if (
      (context.kind === 'project' || context.kind === 'view') &&
      typeof context.id === 'string' &&
      context.id.trim() &&
      typeof context.workspaceId === 'string' &&
      context.workspaceId.trim() &&
      context.workspaceId !== 'all'
    ) {
      next.linearContext = {
        kind: context.kind,
        id: context.id,
        workspaceId: context.workspaceId,
        model: context.model === 'issue' || context.model === 'project' ? context.model : undefined
      }
    }
  }
  if (
    typeof input.jiraPreset === 'string' &&
    VALID_JIRA_PRESETS.has(input.jiraPreset as NonNullable<TaskResumeState['jiraPreset']>)
  ) {
    next.jiraPreset = input.jiraPreset as NonNullable<TaskResumeState['jiraPreset']>
  }
  if (typeof input.jiraQuery === 'string') {
    next.jiraQuery = input.jiraQuery
  }

  return Object.keys(next).length > 0 ? next : undefined
}

export function hydratedUIPartialMatchesState(
  state: AppState,
  hydrated: Partial<UISlice>
): boolean {
  return Object.entries(hydrated).every(([key, value]) =>
    // Cross-slice keys (right-sidebar widths, cleanup browse) resolve through AppState.
    persistedUIValuesEqual(state[key as keyof AppState], value)
  )
}
