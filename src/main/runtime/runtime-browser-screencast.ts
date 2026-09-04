/* eslint-disable @typescript-eslint/no-explicit-any -- Why: runtime dependencies use `any` for loose coupling with service instance */
import type { RuntimeBrowserDriverState } from '../../shared/runtime-types'
import type { BrowserScreencastSubscriber } from './browser-screencast-driver-scope'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import {
  persistClientHostedBrowserPages,
  rehydrateClientHostedBrowserPages as rehydrateClientHostedBrowserPagesImpl
} from './client-hosted-browser-page-persistence'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import type { WorkspaceSessionState } from '../../shared/runtime-types'

export type RuntimeBrowserScreencastDeps = {
  readonly store: any
  readonly notifier: any
  readonly currentBrowserDriver: Map<string, RuntimeBrowserDriverState>
  readonly browserRemoteViewerPages: Set<string>
  readonly activeBrowserScreencastsByPage: Map<string, Set<BrowserScreencastSubscriber>>
  readonly persistedClientHostedBrowserWorktreeIds: Set<string>
  listWorkspaceSessionPartitions(): WorkspaceSessionState[]
  getWorkspaceSessionForWorktree(id: string): any
  setWorkspaceSessionForWorktree(id: string, session: any): void
}

export function rehydrateClientHostedBrowserPages(runtime: RuntimeBrowserScreencastDeps): void {
  if (!runtime.store?.getWorkspaceSession) {
    return
  }
  try {
    const registry = getRuntimeBrowserPageRegistry(runtime as any)
    const liveRepoIds = new Set((runtime.store.getRepos?.() ?? []).map((repo: any) => repo.id))
    rehydrateClientHostedBrowserPagesImpl(registry, {
      listWorkspaceSessions: () => runtime.listWorkspaceSessionPartitions(),
      isKnownWorktree: (worktreeId: string) => {
        const ownerRepoId = splitWorktreeIdForFilesystem(worktreeId)?.repoId
        return !ownerRepoId || liveRepoIds.has(ownerRepoId)
      }
    })
    for (const page of registry.listPages()) {
      runtime.persistedClientHostedBrowserWorktreeIds.add(page.workspaceId)
    }
  } catch (error) {
    console.warn('[browser-host-lease] client page rehydration failed:', error)
  }
}

export function persistClientHostedBrowserPagesForWorktree(
  runtime: RuntimeBrowserScreencastDeps,
  worktreeId: string
): void {
  const registry = getRuntimeBrowserPageRegistry(runtime as any)
  const hasPages = registry.listPages(worktreeId).length > 0
  if (!hasPages && !runtime.persistedClientHostedBrowserWorktreeIds.has(worktreeId)) {
    return
  }
  if (hasPages) {
    runtime.persistedClientHostedBrowserWorktreeIds.add(worktreeId)
  } else {
    runtime.persistedClientHostedBrowserWorktreeIds.delete(worktreeId)
  }
  persistClientHostedBrowserPages(
    {
      getWorkspaceSession: (id: string) => runtime.getWorkspaceSessionForWorktree(id),
      setWorkspaceSession: (id: string, session: any) =>
        runtime.setWorkspaceSessionForWorktree(id, session)
    },
    registry,
    worktreeId
  )
}

export function getAllBrowserDrivers(
  runtime: RuntimeBrowserScreencastDeps
): Map<string, RuntimeBrowserDriverState> {
  return new Map(runtime.currentBrowserDriver)
}

export function getBrowserDriver(
  runtime: RuntimeBrowserScreencastDeps,
  browserPageId: string
): RuntimeBrowserDriverState {
  return runtime.currentBrowserDriver.get(browserPageId) ?? { kind: 'idle' }
}

export function setBrowserDriver(
  runtime: RuntimeBrowserScreencastDeps,
  browserPageId: string,
  next: RuntimeBrowserDriverState
): void {
  const prev = getBrowserDriver(runtime, browserPageId)
  if (prev.kind === next.kind) {
    if (prev.kind === 'mobile' && next.kind === 'mobile' && prev.clientId === next.clientId) {
      return
    }
    if (prev.kind !== 'mobile' && next.kind !== 'mobile') {
      return
    }
  }
  if (next.kind === 'idle') {
    runtime.currentBrowserDriver.delete(browserPageId)
  } else {
    runtime.currentBrowserDriver.set(browserPageId, next)
  }
  runtime.notifier?.browserDriverChanged?.(browserPageId, next)
}

export function getBrowserRemoteViewerPages(runtime: RuntimeBrowserScreencastDeps): string[] {
  return Array.from(runtime.browserRemoteViewerPages)
}

export function publishBrowserRemoteViewers(
  runtime: RuntimeBrowserScreencastDeps,
  browserPageId: string
): void {
  const watched = (runtime.activeBrowserScreencastsByPage.get(browserPageId)?.size ?? 0) > 0
  if (runtime.browserRemoteViewerPages.has(browserPageId) === watched) {
    return
  }
  if (watched) {
    runtime.browserRemoteViewerPages.add(browserPageId)
  } else {
    runtime.browserRemoteViewerPages.delete(browserPageId)
  }
  runtime.notifier?.browserRemoteViewersChanged?.(browserPageId, watched)
}

export function reclaimBrowserForDesktop(
  runtime: RuntimeBrowserScreencastDeps,
  browserPageId: string
): boolean {
  setBrowserDriver(runtime, browserPageId, { kind: 'desktop' })
  for (const stream of runtime.activeBrowserScreencastsByPage.get(browserPageId) ?? []) {
    if (stream.drivesAsMobile) {
      stream.cancel(true)
    }
  }
  return true
}
