import type { FsChangeEvent } from '../../shared/filesystem-entry-types'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { isWatcherProcessFailure } from '../ipc/parcel-watcher-process-failure'
import {
  getSshFilesystemProvider,
  onSshFilesystemProviderRegistered
} from '../providers/ssh-filesystem-dispatch'
import { assertSshMutationExpectation } from '../ssh/ssh-connection-generation'
import { toSshExecutionHostId } from '../../shared/execution-host'
export function assertRuntimeFileMutationExpectation(
  connectionId: string | undefined,
  expectedExecutionHostId: string | undefined,
  expectedSshTargetId: string | undefined,
  expectedSshConnectionGeneration: number | undefined
): void {
  if (!expectedExecutionHostId) {
    throw new Error(RUNTIME_FILE_MUTATION_UPDATE_REQUIRED)
  }
  const actualExecutionHostId = connectionId ? toSshExecutionHostId(connectionId) : 'local'
  if (expectedExecutionHostId !== actualExecutionHostId) {
    throw new Error('Workspace host changed; refresh and try again')
  }
  assertSshMutationExpectation(connectionId, expectedSshTargetId, expectedSshConnectionGeneration)
}

// Why: files.watch cleanup is synchronous RPC; track native Parcel unsubscribes so shutdown can drain them.
export const pendingRuntimeFileWatcherUnsubscribes = new Set<Promise<void>>()

type RuntimeFileWatcherLease = {
  suspend(): Promise<void>
  resume(): Promise<void>
  forget(): void
}
export const runtimeFileWatcherLeasesByOwnerAndRoot = new Map<string, Set<RuntimeFileWatcherLease>>()
// Why: the provider's dispose() stops each watch registration without firing its terminal callback,
// so a dropped SSH transport leaves this watch silently dead — a reconnect's fresh provider is the
// only signal it can be rebuilt from. Keyed like the leases so worktree removal can drop it.
export const sshFileExplorerWatchRearms = new Map<string, Set<() => void>>()

export function trackRuntimeFileWatcherUnsubscribe(
  rootPath: string,
  unsubscribe: () => Promise<void>
): Promise<void> {
  const promise = Promise.resolve()
    .then(unsubscribe)
    .finally(() => {
      pendingRuntimeFileWatcherUnsubscribes.delete(promise)
    })
  pendingRuntimeFileWatcherUnsubscribes.add(promise)
  void promise.catch((err: unknown) => {
    console.error('[runtime-files.watch] unsubscribe error', { rootPath, err })
  })
  return promise
}

export function normalizeRuntimeWatcherRoot(rootPath: string): string {
  return normalizeRuntimePathForComparison(rootPath)
}

export function runtimeWatcherReleaseKey(
  runtimeId: string,
  connectionId: string | undefined,
  rootPath: string
): string {
  // Why: identical absolute paths exist on local and multiple SSH hosts; scope teardown to the host that owns it.
  return JSON.stringify([runtimeId, connectionId ?? null, normalizeRuntimeWatcherRoot(rootPath)])
}

/**
 * Keep an SSH file-explorer watch alive across reconnects.
 *
 * Why: the previous provider's unwatch handle belongs to the dead transport, so reinstalling on the
 * fresh provider is the only way the subscription comes back. Callers get an overflow because the
 * events lost while the watch was down can't be replayed.
 */
export function armSshFileExplorerWatchRearm(args: {
  runtimeId: string
  connectionId: string
  rootPath: string
  callback: (events: FsChangeEvent[]) => void
  onTerminalError: (error: Error) => void
  signal?: AbortSignal
  initialUnwatch: () => void
}): { unsubscribe: () => Promise<void> } {
  const key = runtimeWatcherReleaseKey(args.runtimeId, args.connectionId, args.rootPath)
  let currentUnwatch = args.initialUnwatch
  let stopped = false
  let reinstalling: Promise<void> | null = null

  const reinstall = async (): Promise<void> => {
    const provider = getSshFilesystemProvider(args.connectionId)
    if (stopped || !provider) {
      return
    }
    // Why: the old handle is scoped to the dead transport; closing it here would only risk
    // unwatching the root we just re-registered on the new one.
    const nextUnwatch = await provider.watch(args.rootPath, args.callback, {
      signal: args.signal,
      onTerminalError: args.onTerminalError
    })
    if (stopped) {
      nextUnwatch()
      return
    }
    currentUnwatch = nextUnwatch
    args.callback([{ kind: 'overflow', absolutePath: args.rootPath }])
  }

  const unsubscribeRearm = onSshFilesystemProviderRegistered((registeredId) => {
    if (registeredId !== args.connectionId || stopped) {
      return
    }
    // Why: reconnect storms can register repeatedly; chain so a second one can't double-install.
    const attempt = (reinstalling ?? Promise.resolve())
      .then(reinstall)
      .catch((error: unknown) => {
        args.onTerminalError(error instanceof Error ? error : new Error(String(error)))
      })
      .finally(() => {
        if (reinstalling === attempt) {
          reinstalling = null
        }
      })
    reinstalling = attempt
  })

  const stop = (): void => {
    stopped = true
    unsubscribeRearm()
    const rearms = sshFileExplorerWatchRearms.get(key)
    rearms?.delete(stop)
    if (rearms?.size === 0) {
      sshFileExplorerWatchRearms.delete(key)
    }
  }
  const rearms = sshFileExplorerWatchRearms.get(key) ?? new Set<() => void>()
  rearms.add(stop)
  sshFileExplorerWatchRearms.set(key, rearms)

  return {
    unsubscribe: () => {
      stop()
      const close = async (): Promise<void> => currentUnwatch()
      // Why: awaiting an absent reinstall costs a microtask, and removal gating relies on the
      // unwatch being issued on the same turn the lease releases it.
      return reinstalling ? reinstalling.catch(() => undefined).then(close) : close()
    }
  }
}

export function stopSshFileExplorerWatchRearms(key: string): void {
  for (const stop of Array.from(sshFileExplorerWatchRearms.get(key) ?? [])) {
    stop()
  }
}

export function registerRuntimeFileWatcherRelease(
  runtimeId: string,
  connectionId: string | undefined,
  rootPaths: string[],
  unsubscribe: () => Promise<void>,
  restart: () => Promise<() => Promise<void>>,
  onRestoreError: (error: Error) => void
): () => Promise<void> {
  const keys = Array.from(
    new Set(
      rootPaths.map((rootPath) => runtimeWatcherReleaseKey(runtimeId, connectionId, rootPath))
    )
  )
  let currentUnsubscribe: (() => Promise<void>) | null = unsubscribe
  let releasePromise: Promise<void> | null = null
  let physicalExitPromise: Promise<void> | null = null
  let resumePromise: Promise<void> | null = null
  let stopPromise: Promise<void> | null = null
  let logicallyStopped = false
  const removeLease = (): void => {
    for (const key of keys) {
      const leases = runtimeFileWatcherLeasesByOwnerAndRoot.get(key)
      leases?.delete(lease)
      if (leases?.size === 0) {
        runtimeFileWatcherLeasesByOwnerAndRoot.delete(key)
      }
    }
  }
  const suspend = (): Promise<void> => {
    if (releasePromise) {
      return releasePromise
    }
    const release = currentUnsubscribe
    if (!release) {
      return Promise.resolve()
    }
    const attempt = trackRuntimeFileWatcherUnsubscribe(rootPaths[0], release)
    releasePromise = attempt
    void attempt.then(
      () => {
        if (currentUnsubscribe === release) {
          currentUnsubscribe = null
        }
        releasePromise = null
      },
      (error: unknown) => {
        if (isWatcherProcessFailure(error) && error.physicalExit) {
          const physicalExit = error.physicalExit.then(() => {
            if (currentUnsubscribe === release) {
              currentUnsubscribe = null
            }
            releasePromise = null
            if (physicalExitPromise === physicalExit) {
              physicalExitPromise = null
            }
            if (logicallyStopped) {
              removeLease()
            }
          })
          physicalExitPromise = physicalExit
        } else {
          // Why: a synchronous close failure retains the native owner so a later removal or unsubscribe can retry the same handle.
          releasePromise = null
        }
      }
    )
    return attempt
  }
  const lease: RuntimeFileWatcherLease = {
    suspend,
    resume: () => {
      if (logicallyStopped || (currentUnsubscribe && !physicalExitPromise)) {
        return Promise.resolve()
      }
      if (resumePromise) {
        return physicalExitPromise ? Promise.resolve() : resumePromise
      }
      // Why: a timed-out child still owns native handles until physical exit; join that owner before starting a replacement.
      const resumesAfterPhysicalExit = physicalExitPromise !== null
      const attempt = Promise.resolve(physicalExitPromise ?? releasePromise)
        .then(async () => {
          if (logicallyStopped) {
            return
          }
          const nextUnsubscribe = await restart()
          if (logicallyStopped) {
            await nextUnsubscribe()
            return
          }
          currentUnsubscribe = nextUnsubscribe
        })
        .catch((error: unknown) => {
          const restoreError = error instanceof Error ? error : new Error(String(error))
          queueMicrotask(() => onRestoreError(restoreError))
          throw restoreError
        })
        .finally(() => {
          resumePromise = null
        })
      resumePromise = attempt
      if (resumesAfterPhysicalExit) {
        void attempt.catch(() => {})
        return Promise.resolve()
      }
      return attempt
    },
    forget: () => {
      logicallyStopped = true
      removeLease()
    }
  }
  for (const key of keys) {
    const leases = runtimeFileWatcherLeasesByOwnerAndRoot.get(key) ?? new Set()
    leases.add(lease)
    runtimeFileWatcherLeasesByOwnerAndRoot.set(key, leases)
  }
  return () => {
    if (stopPromise) {
      return stopPromise
    }
    logicallyStopped = true
    const release =
      resumePromise && !physicalExitPromise
        ? Promise.resolve(resumePromise)
            .catch(() => undefined)
            .then(suspend)
        : suspend()
    const attempt = release.then(removeLease).catch((error: unknown) => {
      stopPromise = null
      throw error
    })
    stopPromise = attempt
    return attempt
  }
}

export async function awaitRuntimeFileWatcherUnsubscribes(): Promise<void> {
  await Promise.allSettled(Array.from(pendingRuntimeFileWatcherUnsubscribes))
}

export function _getRuntimeFileWatcherReleaseCountForTests(): number {
  const leases = new Set<RuntimeFileWatcherLease>()
  for (const rootLeases of runtimeFileWatcherLeasesByOwnerAndRoot.values()) {
    for (const lease of rootLeases) {
      leases.add(lease)
    }
  }
  return leases.size
}

export function _resetRuntimeFileWatcherLeasesForTests(): void {
  const leases = new Set<RuntimeFileWatcherLease>()
  for (const rootLeases of runtimeFileWatcherLeasesByOwnerAndRoot.values()) {
    for (const lease of rootLeases) {
      leases.add(lease)
    }
  }
  for (const lease of leases) {
    lease.forget()
  }
  for (const key of Array.from(sshFileExplorerWatchRearms.keys())) {
    stopSshFileExplorerWatchRearms(key)
  }
  runtimeFileWatcherLeasesByOwnerAndRoot.clear()
}
