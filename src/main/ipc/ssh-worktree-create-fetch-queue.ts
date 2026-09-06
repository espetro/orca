import type { RemoteTrackingBase } from '../runtime/orca-runtime'
import type { Repo } from '../../shared/repo-types'
import type { SshGitProvider } from '../providers/ssh-git-provider'

const SSH_WORKTREE_CREATE_FETCH_FRESHNESS_MS = 30_000
const SSH_WORKTREE_CREATE_FETCH_CACHE_MAX = 512

const sshWorktreeCreateFetchInflight = new Map<string, Promise<void>>()
const sshWorktreeCreateFetchCompletedAt = new Map<string, number>()
const sshWorktreeCreateFetchQueueTail = new Map<string, Promise<void>>()
const sshWorktreeCreateBasePlanInflight = new Map<
  string,
  Promise<RemoteWorktreeCreateBasePlan | null>
>()

export type RemoteWorktreeCreateBasePlan = {
  baseBranch: string
  remoteTrackingBase: RemoteTrackingBase | null
}

function setBoundedSshWorktreeCreateFetchEntry(
  map: Map<string, number>,
  key: string,
  value: number
): void {
  if (map.has(key)) {
    map.delete(key)
  }
  map.set(key, value)
  while (map.size > SSH_WORKTREE_CREATE_FETCH_CACHE_MAX) {
    const oldest = map.keys().next()
    if (oldest.done) {
      return
    }
    map.delete(oldest.value)
  }
}

function getSshWorktreeCreateBaseFetchKey(repo: Repo, base: RemoteTrackingBase): string {
  return `${repo.connectionId ?? 'ssh'}::${repo.path}::base:${base.remote}:${base.branch}`
}

function getSshWorktreeCreateRemoteFetchKey(repo: Repo, remote: string): string {
  return `${repo.connectionId ?? 'ssh'}::${repo.path}::remote:${remote}`
}

function getSshWorktreeCreateRemoteQueueKey(repo: Repo, remote: string): string {
  return `${repo.connectionId ?? 'ssh'}::${repo.path}::queue:${remote}`
}

export function getSshWorktreeCreateBasePlanKey(
  repo: Repo,
  requestedBaseBranch: string | undefined
): string {
  const baseKey = requestedBaseBranch || repo.worktreeBaseRef || 'default'
  return `${repo.connectionId ?? 'ssh'}::${repo.path}::plan:${baseKey}`
}

function getFreshSshWorktreeCreateFetchCompletedAt(key: string): number | null {
  const lastAt = sshWorktreeCreateFetchCompletedAt.get(key)
  if (lastAt === undefined) {
    return null
  }
  if (Date.now() - lastAt < SSH_WORKTREE_CREATE_FETCH_FRESHNESS_MS) {
    setBoundedSshWorktreeCreateFetchEntry(sshWorktreeCreateFetchCompletedAt, key, lastAt)
    return lastAt
  }
  sshWorktreeCreateFetchCompletedAt.delete(key)
  return null
}

function rememberSshWorktreeCreateFetchCompletedAt(key: string): void {
  setBoundedSshWorktreeCreateFetchEntry(sshWorktreeCreateFetchCompletedAt, key, Date.now())
}

function enqueueSshWorktreeCreateFetch(
  queueKey: string,
  fetch: () => Promise<void>
): Promise<void> {
  const previous = sshWorktreeCreateFetchQueueTail.get(queueKey)
  const promise = previous ? previous.then(fetch, fetch) : fetch()
  sshWorktreeCreateFetchQueueTail.set(queueKey, promise)
  const clearQueueTail = (): void => {
    if (sshWorktreeCreateFetchQueueTail.get(queueKey) === promise) {
      sshWorktreeCreateFetchQueueTail.delete(queueKey)
    }
  }
  promise.then(clearQueueTail, clearQueueTail)
  return promise
}

function getOrStartSshWorktreeCreateFetch(
  key: string,
  queueKey: string,
  fetch: () => Promise<void>
): Promise<void> {
  if (getFreshSshWorktreeCreateFetchCompletedAt(key) !== null) {
    return Promise.resolve()
  }
  const existing = sshWorktreeCreateFetchInflight.get(key)
  if (existing) {
    return existing
  }
  const promise = enqueueSshWorktreeCreateFetch(queueKey, async () => {
    if (getFreshSshWorktreeCreateFetchCompletedAt(key) !== null) {
      return
    }
    await fetch()
    // Why: SSH creation has no OrcaRuntimeService to share; still reuse recent fetches for repeated creates on the same target.
    rememberSshWorktreeCreateFetchCompletedAt(key)
  }).finally(() => {
    if (sshWorktreeCreateFetchInflight.get(key) === promise) {
      sshWorktreeCreateFetchInflight.delete(key)
    }
  })
  sshWorktreeCreateFetchInflight.set(key, promise)
  return promise
}

export async function refreshRemoteTrackingBaseForWorktreeCreate(
  provider: SshGitProvider,
  repo: Repo,
  base: RemoteTrackingBase
): Promise<void> {
  return getOrStartSshWorktreeCreateFetch(
    getSshWorktreeCreateBaseFetchKey(repo, base),
    getSshWorktreeCreateRemoteQueueKey(repo, base.remote),
    () =>
      // Why: the exact-base refresh gates create; unrelated repo housekeeping must not extend it.
      provider.fetchRemoteTrackingRef(repo.path, base.remote, base.branch, base.ref, {
        skipAutoMaintenance: true
      })
  )
}

export async function fetchRemoteForWorktreeCreate(
  provider: SshGitProvider,
  repo: Repo,
  remote: string
): Promise<void> {
  return getOrStartSshWorktreeCreateFetch(
    getSshWorktreeCreateRemoteFetchKey(repo, remote),
    getSshWorktreeCreateRemoteQueueKey(repo, remote),
    () => provider.exec(['fetch', remote], repo.path).then(() => undefined)
  )
}

export function resetSshWorktreeCreateFetchCache(): void {
  sshWorktreeCreateFetchInflight.clear()
  sshWorktreeCreateFetchCompletedAt.clear()
  sshWorktreeCreateFetchQueueTail.clear()
  sshWorktreeCreateBasePlanInflight.clear()
}

export function getOrStartSshWorktreeCreateBasePlanInflight(
  key: string,
  start: () => Promise<RemoteWorktreeCreateBasePlan | null>
): Promise<RemoteWorktreeCreateBasePlan | null> {
  const existing = sshWorktreeCreateBasePlanInflight.get(key)
  if (existing) {
    return existing
  }
  const promise = start().finally(() => {
    if (sshWorktreeCreateBasePlanInflight.get(key) === promise) {
      sshWorktreeCreateBasePlanInflight.delete(key)
    }
  })
  sshWorktreeCreateBasePlanInflight.set(key, promise)
  return promise
}
