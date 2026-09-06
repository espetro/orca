/* eslint-disable max-lines -- Why: split slice of the runtime behavior suite; mocks are duplicated per file because vi.mock is file-scoped */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetRuntimeTestMocks,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  createRuntime,
  deleteWorktreeHistoryDirMock,
  store
} from './orca-runtime-test-fixture'

import { OrcaRuntimeService } from './orca-runtime'

import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import { getBrowserHostLeaseRegistry } from './browser-host-lease-registry-instance'

import type { BrowserClientHostCommandEvent } from '../../shared/browser-client-host-protocol'
import type { RuntimeBrowserClientPlacement } from '../../shared/runtime-browser-placement'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
  it('closes a worktree’s offscreen browser pages when its metadata is removed (leak fix)', () => {
    const runtime = createRuntime()
    const closeTab = vi.fn().mockResolvedValue(undefined)
    runtime.setOffscreenBrowserBackend({ createTab: vi.fn(), closeTab })
    runtime.setAgentBrowserBridge({
      tabList: vi.fn((worktreeId: string) =>
        worktreeId === TEST_WORKTREE_ID
          ? { tabs: [{ browserPageId: 'page-a' }, { browserPageId: 'page-b' }] }
          : { tabs: [] }
      )
    } as never)

    runtime['removeWorktreeMetadataAndHistory'](store as never, TEST_WORKTREE_ID)

    expect(closeTab).toHaveBeenCalledWith('page-a')
    expect(closeTab).toHaveBeenCalledWith('page-b')
    expect(closeTab).toHaveBeenCalledTimes(2)
  })

  it('closes a worktree’s client-hosted browser pages when its metadata is removed (leak fix)', async () => {
    const runtime = createRuntime()
    const host = attachClientBrowserHost(runtime)
    const removed = await publishClientHostedPage(runtime, host, 'page-removed', TEST_WORKTREE_ID)
    const survivor = await publishClientHostedPage(
      runtime,
      host,
      'page-other',
      `${TEST_REPO_ID}::/tmp/other`
    )

    runtime['removeWorktreeMetadataAndHistory'](store as never, TEST_WORKTREE_ID)

    expect(host.takeCommands()).toEqual([
      expect.objectContaining({
        browserPageId: 'page-removed',
        pageHostGeneration: removed.pageHostGeneration,
        command: {
          type: 'closePage',
          targetAuthority: {
            authorityRuntimeId: runtime.getRuntimeId(),
            authorityEpoch: getBrowserHostLeaseRegistry(runtime).authorityEpoch,
            browserHostClientId: removed.browserHostClientId,
            browserHostGeneration: removed.browserHostGeneration,
            pageHostGeneration: removed.pageHostGeneration
          }
        }
      })
    ])
    expect(getRuntimeBrowserPageRegistry(runtime).getPage('page-removed')).toBeUndefined()
    expect(getRuntimeBrowserPageRegistry(runtime).getPage('page-other')?.placement).toEqual(
      survivor
    )
  })

  it('does not republish a removed worktree’s client tabs to a same-id recreate', async () => {
    const runtime = createRuntime()
    const host = attachClientBrowserHost(runtime)
    await publishClientHostedPage(runtime, host, 'page-removed', TEST_WORKTREE_ID)

    runtime['removeWorktreeMetadataAndHistory'](store as never, TEST_WORKTREE_ID)

    // The store's surviving metadata stands in for a recreate at the same path: the ID resolves again.
    expect(runtime['buildHeadlessMobileSessionBrowserTabs'](TEST_WORKTREE_ID)).toEqual([])
    expect((await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)).tabs).toEqual([])
  })

  it('drops a client page record even when its close command cannot be issued', async () => {
    const runtime = createRuntime()
    const host = attachClientBrowserHost(runtime)
    await publishClientHostedPage(runtime, host, 'page-removed', TEST_WORKTREE_ID)
    // The client's command transport is gone but its lease has not fenced yet.
    host.detachDelivery()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    runtime['removeWorktreeMetadataAndHistory'](store as never, TEST_WORKTREE_ID)

    expect(getRuntimeBrowserPageRegistry(runtime).getPage('page-removed')).toBeUndefined()
    expect(runtime['buildHeadlessMobileSessionBrowserTabs'](TEST_WORKTREE_ID)).toEqual([])
    // The close really did fail, and its rejection was reported rather than left unhandled.
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('could not close its client page'),
        expect.objectContaining({
          browserPageId: 'page-removed',
          error: expect.objectContaining({ message: 'browser_host_command_delivery_required' })
        })
      )
    )
    warn.mockRestore()
  })

  it('leaves client-hosted pages alone when another host still owns the same worktree id', async () => {
    const runtimeStore = {
      ...store,
      getWorktreeMeta: () => ({ ...store.getWorktreeMeta(TEST_WORKTREE_ID), hostId: 'local' }),
      removeWorktreeMeta: vi.fn()
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const host = attachClientBrowserHost(runtime)
    const placement = await publishClientHostedPage(runtime, host, 'page-kept', TEST_WORKTREE_ID)

    runtime['removeWorktreeMetadataAndHistory'](
      runtimeStore as never,
      TEST_WORKTREE_ID,
      'runtime:env-b'
    )

    expect(host.takeCommands()).toEqual([])
    expect(getRuntimeBrowserPageRegistry(runtime).getPage('page-kept')?.placement).toEqual(
      placement
    )
  })

  function attachClientBrowserHost(runtime: OrcaRuntimeService) {
    const leases = getBrowserHostLeaseRegistry(runtime)
    let commands: BrowserClientHostCommandEvent[] = []
    const { lease } = leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-a',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview'],
      pageCommandProtocolVersion: 1,
      pageInventoryProtocolVersion: 1,
      pageInventory: [],
      pageReconciliationProtocolVersion: 1
    })
    const identity = {
      authorityEpoch: lease.authorityEpoch,
      browserHostClientId: lease.browserHostClientId,
      browserHostGeneration: lease.browserHostGeneration,
      pairedDeviceId: lease.pairedDeviceId
    }
    const detachDelivery = leases.attachCommandDelivery(identity, (event) => commands.push(event))
    return {
      detachDelivery,
      takeCommands(): BrowserClientHostCommandEvent[] {
        const taken = commands
        commands = []
        return taken
      },
      settleLatest(): void {
        const command = commands.at(-1)
        if (!command) {
          throw new Error('no command was delivered to the client host')
        }
        leases.settleClientPageCommand(
          { ...identity, connectionId: lease.connectionId },
          {
            authorityRuntimeId: command.authorityRuntimeId,
            authorityEpoch: command.authorityEpoch,
            browserHostClientId: command.browserHostClientId,
            browserHostGeneration: command.browserHostGeneration,
            pageCommandProtocolVersion: command.pageCommandProtocolVersion,
            ...(command.pageReconciliationProtocolVersion
              ? { pageReconciliationProtocolVersion: command.pageReconciliationProtocolVersion }
              : {}),
            browserPageId: command.browserPageId,
            pageHostGeneration: command.pageHostGeneration,
            commandSequence: command.commandSequence,
            commandId: command.commandId,
            result: { status: 'completed' }
          }
        )
      }
    }
  }

  async function publishClientHostedPage(
    runtime: OrcaRuntimeService,
    host: ReturnType<typeof attachClientBrowserHost>,
    browserPageId: string,
    workspaceId: string
  ): Promise<RuntimeBrowserClientPlacement> {
    const creation = getBrowserHostLeaseRegistry(runtime).createClientPage({
      browserPageId,
      browserHostClientId: 'host-a',
      pairedDeviceId: 'device-a',
      browserProfileId: 'profile-a',
      executionHostKey: 'native:runtime-a:7'
    })
    host.settleLatest()
    const placement = await creation
    getRuntimeBrowserPageRegistry(runtime).publishClientPage({
      browserPageId,
      workspaceId,
      browserProfileId: 'profile-a',
      executionHostKey: 'native:runtime-a:7',
      placement,
      url: 'https://remote.internal/',
      loading: false,
      active: true
    })
    host.takeCommands()
    return placement
  }

  it('preserves bare-id runtime state when removing a different qualified owner', () => {
    const removeWorktreeMeta = vi.fn()
    const runtimeStore = {
      ...store,
      getWorktreeMeta: () => ({ ...store.getWorktreeMeta(TEST_WORKTREE_ID), hostId: 'local' }),
      removeWorktreeMeta
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const internals = runtime as unknown as {
      mobileSessionTabsByWorktree: Map<string, unknown>
      removeWorktreeMetadataAndHistory: (
        runtimeStore: typeof store,
        worktreeId: string,
        hostId: string
      ) => void
    }
    const localSession = { tabs: [{ id: 'local-tab' }] }
    internals.mobileSessionTabsByWorktree.set(TEST_WORKTREE_ID, localSession)

    internals.removeWorktreeMetadataAndHistory(
      runtimeStore as typeof store,
      TEST_WORKTREE_ID,
      'runtime:env-b'
    )

    expect(removeWorktreeMeta).toHaveBeenCalledWith(TEST_WORKTREE_ID, 'runtime:env-b')
    expect(internals.mobileSessionTabsByWorktree.get(TEST_WORKTREE_ID)).toBe(localSession)
  })

  it('preserves bare-id runtime state when removed-host metadata masks another owner', () => {
    const localRepo = store.getRepo(TEST_REPO_ID)!
    const remoteRepo = { ...localRepo, connectionId: 'ssh-1' }
    const removeWorktreeMeta = vi.fn()
    const runtimeStore = {
      ...store,
      getRepos: () => [localRepo, remoteRepo],
      getWorktreeMeta: () => ({ ...store.getWorktreeMeta(TEST_WORKTREE_ID), hostId: 'ssh:ssh-1' }),
      removeWorktreeMeta
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const internals = runtime as unknown as {
      mobileSessionTabsByWorktree: Map<string, unknown>
      removeWorktreeMetadataAndHistory: (
        runtimeStore: typeof store,
        worktreeId: string,
        hostId: string
      ) => void
    }
    const survivingSession = { tabs: [{ id: 'same-id-local-tab' }] }
    internals.mobileSessionTabsByWorktree.set(TEST_WORKTREE_ID, survivingSession)
    deleteWorktreeHistoryDirMock.mockClear()

    internals.removeWorktreeMetadataAndHistory(
      runtimeStore as typeof store,
      TEST_WORKTREE_ID,
      'ssh:ssh-1'
    )

    expect(removeWorktreeMeta).toHaveBeenCalledWith(TEST_WORKTREE_ID, 'ssh:ssh-1')
    expect(internals.mobileSessionTabsByWorktree.get(TEST_WORKTREE_ID)).toBe(survivingSession)
    expect(deleteWorktreeHistoryDirMock).not.toHaveBeenCalled()
  })

  it('rejects a qualified removal when only another host has persisted ownership', async () => {
    const runtimeStore = {
      ...store,
      getWorktreeMeta: () => ({ ...store.getWorktreeMeta(TEST_WORKTREE_ID), hostId: 'local' })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const internals = runtime as unknown as {
      listResolvedWorktrees: () => Promise<unknown[]>
      resolveWorktreeRemovalTarget: (
        worktreeSelector: string,
        requiredHostId?: string
      ) => Promise<unknown>
    }
    internals.listResolvedWorktrees = vi.fn().mockResolvedValue([
      {
        id: TEST_WORKTREE_ID,
        repoId: TEST_REPO_ID,
        path: TEST_WORKTREE_PATH,
        hostId: 'local'
      }
    ])

    await expect(
      internals.resolveWorktreeRemovalTarget(TEST_WORKTREE_ID, 'runtime:env-b')
    ).rejects.toThrow('selector_not_found')
    expect(internals.listResolvedWorktrees).not.toHaveBeenCalled()
  })
})
