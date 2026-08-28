import type { Page } from '@stablyai/playwright-test'

import type { DirectSshAuthority } from '../../../src/shared/ssh-types'

import {
  DOCKER_SSH_PROXY_JUMP_REMOTE_REPO_PATH,
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  type DockerSshRelayTarget
} from './docker-ssh-relay-target'

export type ConnectedDockerSshRelayTarget = {
  targetId: string
  repoId: string
  worktreeId: string
}

type DockerSshRelayConnectionOptions = {
  relayGracePeriodSeconds?: number
  remotePath?: string
  viaProxyJump?: boolean
  /**
   * Seed a terminal tab when the worktree has none. Default true.
   *
   * Why it is optional: a spec asking whether the PRODUCT adds a tab cannot tell this helper's
   * tab from the one under test, so it must be able to leave the worktree empty.
   */
  seedInitialTab?: boolean
}

export async function connectDockerSshRelayTarget(
  page: Page,
  target: DockerSshRelayTarget,
  options: DockerSshRelayConnectionOptions = {}
): Promise<ConnectedDockerSshRelayTarget> {
  return page.evaluate(
    async ({ target, remotePath, relayGracePeriodSeconds, viaProxyJump, seedInitialTab }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      const credentialUnsub = window.api.ssh.onCredentialRequest((request) => {
        void window.api.ssh.submitCredential({ requestId: request.requestId, value: null })
      })
      try {
        const { target: createdTarget, repoReadoptions } = await window.api.ssh.addTarget({
          target: {
            label: `${viaProxyJump ? 'Docker SSH ProxyJump' : 'Docker SSH Relay'} E2E ${Date.now()}`,
            ...(viaProxyJump ? { configHost: 'orca-e2e-destination' } : {}),
            host: target.host,
            port: viaProxyJump ? 22 : target.port,
            username: 'root',
            identityFile: target.identityFile,
            identitiesOnly: true,
            ...(viaProxyJump ? { jumpHost: 'orca-e2e-jump' } : {}),
            relayGracePeriodSeconds
          }
        })
        store.getState().recordSshRepoReadoptions(repoReadoptions)
        const state = await window.api.ssh.connect({ targetId: createdTarget.id })
        if (!state || state.status !== 'connected') {
          throw new Error(`SSH target did not connect: ${JSON.stringify(state)}`)
        }
        if (
          !state.providerEpoch ||
          !Number.isSafeInteger(state.connectionGeneration) ||
          state.connectionGeneration === undefined ||
          state.connectionGeneration < 0
        ) {
          throw new Error(`SSH target returned incomplete authority: ${JSON.stringify(state)}`)
        }
        store.getState().setSshConnectionState(createdTarget.id, state)
        const labels = new Map(store.getState().sshTargetLabels)
        labels.set(createdTarget.id, createdTarget.label)
        store.getState().setSshTargetLabels(labels)
        const executionHostId = `ssh:${encodeURIComponent(createdTarget.id)}` as const
        const liveAuthority = (): DirectSshAuthority | null => {
          const current = store.getState().sshConnectionStates.get(createdTarget.id)
          const generation = current?.connectionGeneration
          if (
            current?.status !== 'connected' ||
            !current.providerEpoch ||
            typeof generation !== 'number' ||
            !Number.isSafeInteger(generation) ||
            generation < 0
          ) {
            return null
          }
          return {
            targetId: createdTarget.id,
            providerEpoch: current.providerEpoch,
            connectionGeneration: generation
          }
        }
        const waitForLiveAuthority = async (
          deadline: number
        ): Promise<DirectSshAuthority | null> => {
          const immediate = liveAuthority()
          if (immediate) {
            return immediate
          }
          return await new Promise<DirectSshAuthority | null>((resolve) => {
            // Hoisted so the timeout arm cannot depend on the subscribe call having been
            // evaluated first; today it always has, but the arm only runs on failure.
            let unsubscribe: (() => void) | undefined
            const timer = window.setTimeout(
              () => {
                unsubscribe?.()
                resolve(null)
              },
              Math.max(0, deadline - Date.now())
            )
            unsubscribe = store.subscribe(() => {
              const next = liveAuthority()
              if (!next) {
                return
              }
              window.clearTimeout(timer)
              unsubscribe?.()
              resolve(next)
            })
          })
        }

        const result = await window.api.repos.addRemote({
          connectionId: createdTarget.id,
          remotePath,
          displayName: viaProxyJump ? 'Docker SSH ProxyJump E2E' : 'Docker SSH Relay E2E'
        })
        if ('error' in result) {
          throw new Error(result.error)
        }
        const hasExpectedRepoOwner = (): boolean =>
          store
            .getState()
            .repos.some(
              (repo) =>
                repo.id === result.repo.id &&
                repo.connectionId === createdTarget.id &&
                repo.executionHostId === executionHostId
            )
        const waitForRepoOwner = async (): Promise<void> => {
          if (hasExpectedRepoOwner()) {
            return
          }
          await new Promise<void>((resolve, reject) => {
            const timer = window.setTimeout(() => {
              unsubscribe()
              reject(new Error(`Remote repo owner did not hydrate for ${result.repo.path}`))
            }, 15_000)
            const unsubscribe = store.subscribe((next) => {
              if (
                !next.repos.some(
                  (repo) =>
                    repo.id === result.repo.id &&
                    repo.connectionId === createdTarget.id &&
                    repo.executionHostId === executionHostId
                )
              ) {
                return
              }
              window.clearTimeout(timer)
              unsubscribe()
              resolve()
            })
          })
        }
        await store.getState().fetchRepos()
        await waitForRepoOwner()

        // Why hydration loops instead of sampling once: something in setup bounces the SSH
        // transport on this fixture (cause unknown), and a listing whose authority rotates
        // mid-flight comes back stale rather than complete, so one sample fails on fixture timing
        // rather than on anything a spec is about. Re-derive the live authority and retry; every
        // attempt still has to come back fully authoritative, so this widens when setup gives up,
        // never what it accepts.
        const hydrationDeadline = Date.now() + 60_000
        let lastHydrationFailure = 'no hydration attempt was made'
        let worktreeId: string | null = null
        while (!worktreeId && Date.now() < hydrationDeadline) {
          const authority = await waitForLiveAuthority(hydrationDeadline)
          if (!authority) {
            lastHydrationFailure = 'SSH target never reported a connected authority'
            break
          }
          const worktreeResult = await store.getState().fetchWorktrees(result.repo.id, {
            executionHostId,
            directSshAuthority: authority,
            requireAuthoritative: true
          })
          if (
            worktreeResult.status !== 'complete' ||
            worktreeResult.repoId !== result.repo.id ||
            worktreeResult.authority.kind !== 'direct-ssh' ||
            worktreeResult.authority.executionHostId !== executionHostId ||
            worktreeResult.authority.targetId !== authority.targetId ||
            worktreeResult.authority.providerEpoch !== authority.providerEpoch ||
            worktreeResult.authority.connectionGeneration !== authority.connectionGeneration
          ) {
            lastHydrationFailure = `worktree hydration was not authoritative: ${JSON.stringify(worktreeResult)}`
            await new Promise((resolve) => window.setTimeout(resolve, 250))
            continue
          }
          worktreeId =
            (store.getState().worktreesByRepo[result.repo.id] ?? []).find(
              (candidate) => candidate.hostId === executionHostId
            )?.id ?? null
          if (!worktreeId) {
            lastHydrationFailure = `authoritative listing carried no ${executionHostId} worktree`
            await new Promise((resolve) => window.setTimeout(resolve, 250))
          }
        }
        if (!worktreeId) {
          throw new Error(
            `No remote worktree found for ${result.repo.path}: ${lastHydrationFailure}`
          )
        }
        store.getState().setActiveWorktree(worktreeId)
        if (seedInitialTab && (store.getState().tabsByWorktree[worktreeId] ?? []).length === 0) {
          store.getState().createTab(worktreeId)
        }
        store.getState().setActiveTabType('terminal')
        return {
          targetId: createdTarget.id,
          repoId: result.repo.id,
          worktreeId
        }
      } finally {
        credentialUnsub()
      }
    },
    {
      target,
      remotePath:
        options.remotePath ??
        (options.viaProxyJump
          ? DOCKER_SSH_PROXY_JUMP_REMOTE_REPO_PATH
          : DOCKER_SSH_RELAY_REMOTE_REPO_PATH),
      viaProxyJump: options.viaProxyJump ?? false,
      seedInitialTab: options.seedInitialTab ?? true,
      relayGracePeriodSeconds: options.relayGracePeriodSeconds ?? 1
    }
  )
}

export async function disconnectDockerSshRelayTarget(page: Page, targetId: string): Promise<void> {
  await page.evaluate(async (targetId) => {
    await window.api.ssh.disconnect({ targetId })
  }, targetId)
}

export async function resetDockerSshRelayTarget(page: Page, targetId: string): Promise<void> {
  await page.evaluate(async (targetId) => {
    await window.api.ssh.resetRelay({ targetId })
  }, targetId)
}

async function performDockerSshRelayReconnect(
  page: Page,
  targetId: string,
  disconnectFirst: boolean
): Promise<void> {
  await page.evaluate(
    async ({ targetId, disconnectFirst }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      if (disconnectFirst) {
        await window.api.ssh.disconnect({ targetId })
      }
      const state = await window.api.ssh.connect({ targetId })
      if (!state || state.status !== 'connected') {
        throw new Error(`SSH target did not reconnect: ${JSON.stringify(state)}`)
      }
      store.getState().setSshConnectionState(targetId, state)
    },
    { targetId, disconnectFirst }
  )
}

export async function reconnectDockerSshRelayTarget(page: Page, targetId: string): Promise<void> {
  return performDockerSshRelayReconnect(page, targetId, true)
}

export async function reconnectDisconnectedDockerSshRelayTarget(
  page: Page,
  targetId: string
): Promise<void> {
  return performDockerSshRelayReconnect(page, targetId, false)
}
