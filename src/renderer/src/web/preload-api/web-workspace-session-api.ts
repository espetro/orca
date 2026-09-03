import type { PreloadApi } from '../../../../preload/api-types'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId
} from '../../../../shared/execution-host'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../../shared/workspace-session-state-types'
import { sanitizeWebRuntimeWorkspaceSession } from '../web-workspace-session'
import { readLocalWebUIState } from './web-preferences-store'
import { requireActiveEnvironmentOrNull } from './web-runtime-session'
import { SESSION_STORAGE_KEY, readJson, writeJson } from './web-storage'

function getWebSessionScope(): string | null {
  if (typeof window === 'undefined') {
    return null
  }
  try {
    const params = new URLSearchParams(window.location?.search ?? '')
    const workspaceParam = params.get('workspace')
    if (workspaceParam && workspaceParam.trim().length > 0) {
      return `workspace:${workspaceParam.trim()}`
    }
    const storage = window.sessionStorage
    if (!storage) {
      return null
    }
    let tabId = storage.getItem('orca.web.tab.id')
    if (!tabId) {
      tabId = Math.random().toString(36).slice(2, 10)
      storage.setItem('orca.web.tab.id', tabId)
    }
    return `tab:${tabId}`
  } catch {
    return null
  }
}

export function sessionStorageKeyForHost(hostId?: string | null): string {
  const resolved = normalizeExecutionHostId(hostId) ?? LOCAL_EXECUTION_HOST_ID
  const scope = getWebSessionScope()
  const baseKey = scope ? `${SESSION_STORAGE_KEY}.${scope}` : SESSION_STORAGE_KEY
  return resolved === LOCAL_EXECUTION_HOST_ID ? baseKey : `${baseKey}.${resolved}`
}

export function getStoredWorkspaceSession(hostId?: string | null): WorkspaceSessionState {
  const resolvedHostId = normalizeExecutionHostId(hostId) ?? LOCAL_EXECUTION_HOST_ID
  const scopedKey = sessionStorageKeyForHost(resolvedHostId)
  if (resolvedHostId !== LOCAL_EXECUTION_HOST_ID) {
    return sanitizeWebRuntimeWorkspaceSession(
      readJson(scopedKey, readJson(sessionStorageKeyForHost(), getDefaultWorkspaceSession()))
    )
  }
  const fallback = readJson(SESSION_STORAGE_KEY, getDefaultWorkspaceSession())
  const localSession = sanitizeWebRuntimeWorkspaceSession(readJson(scopedKey, fallback))
  if (!requireActiveEnvironmentOrNull()) {
    return localSession
  }
  const ui = readLocalWebUIState()
  // Why: replaying browser-local terminal handles first creates stale remote PTYs; mirror host session-tabs instead.
  return sanitizeWebRuntimeWorkspaceSession({
    ...getDefaultWorkspaceSession(),
    activeRepoId: ui.lastActiveRepoId,
    activeWorktreeId: ui.lastActiveWorktreeId,
    lastVisitedAtByWorktreeId: localSession.lastVisitedAtByWorktreeId
  })
}

export function createWebWorkspaceSessionApi(): Partial<PreloadApi> {
  return {
    session: {
      // Mirrors desktop bridge: non-local hosts persist under a host-suffixed key so their sessions stay isolated from local.
      get: (hostId) => Promise.resolve(getStoredWorkspaceSession(hostId)),
      set: async (session, hostId) => {
        writeJson(sessionStorageKeyForHost(hostId), sanitizeWebRuntimeWorkspaceSession(session))
      },
      patch: async (patch: WorkspaceSessionPatch, hostId) => {
        writeJson(
          sessionStorageKeyForHost(hostId),
          sanitizeWebRuntimeWorkspaceSession({
            ...getStoredWorkspaceSession(hostId),
            ...patch
          })
        )
      },
      // localStorage writes synchronously, so there is no deferred web flush.
      flush: async () => {},
      readTerminalScrollback: () => null,
      setSync: (session, hostId) => {
        writeJson(sessionStorageKeyForHost(hostId), sanitizeWebRuntimeWorkspaceSession(session))
      }
    }
  }
}
