import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  resetRuntimeTestMocks,
  store,
  syncSinglePty
} from './orca-runtime-test-fixture'
import { OrcaRuntimeService } from './orca-runtime'
import { advertisedUrlWatcher } from '../ports/advertised-url-watcher'

beforeEach(resetRuntimeTestMocks)
afterEach(resetRuntimeTestMocks)

describe('OrcaRuntimeService', () => {
  it('binds advertised URLs for renderer-restored PTYs that skip registerPty', () => {
    const runtime = new OrcaRuntimeService(store)

    syncSinglePty(runtime, 'pty-restored')
    runtime.onPtyData('pty-restored', 'Network: https://restored.example.com:3001/\n', 100)

    expect(advertisedUrlWatcher.lookup(TEST_WORKTREE_ID, 3001)?.origin).toBe(
      'https://restored.example.com:3001'
    )
  })

  it('keeps preallocated terminal handles valid across renderer reloads', async () => {
    const runtime = new OrcaRuntimeService(store)
    const handle = runtime.preAllocateHandleForPty('pty-1')

    syncSinglePty(runtime)
    runtime.markRendererReloading(1)
    syncSinglePty(runtime, null)
    runtime.onPtyData('pty-1', 'after reload\n', 100)

    const read = await runtime.readTerminal(handle)
    expect(read.tail).toEqual(['after reload'])
  })

  it('keeps preallocated terminal handles valid when a reload graph omits the live leaf', async () => {
    const runtime = new OrcaRuntimeService(store)
    const handle = runtime.preAllocateHandleForPty('pty-1')

    syncSinglePty(runtime)
    runtime.markRendererReloading(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: []
    })
    runtime.onPtyData('pty-1', 'after omitted leaf\n', 100)

    const read = await runtime.readTerminal(handle)
    expect(read.tail).toEqual(['after omitted leaf'])
  })

  it('keeps preallocated terminal handles valid after graph unavailable during reload', async () => {
    const runtime = new OrcaRuntimeService(store)
    const handle = runtime.preAllocateHandleForPty('pty-1')

    syncSinglePty(runtime)
    runtime.markGraphUnavailable(1)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: []
    })
    runtime.onPtyData('pty-1', 'after unavailable\n', 100)

    const read = await runtime.readTerminal(handle)
    expect(read.tail).toEqual(['after unavailable'])
  })

  it('keeps runtime-created PTY handles valid after graph unavailable', async () => {
    const writes: string[] = []
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    runtime.markGraphUnavailable(1)
    runtime.onPtyData('pty-bg', 'after unavailable\n', 100)

    await expect(runtime.readTerminal(handle)).resolves.toMatchObject({
      handle,
      tail: ['after unavailable']
    })
    await expect(runtime.sendTerminal(handle, { text: 'still writable' })).resolves.toMatchObject({
      handle,
      accepted: true
    })
    expect(writes).toEqual(['still writable'])
  })

  it('preserves runtime-created PTY process identity after graph unavailable', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    const incarnation = runtime.getTerminalProcessIncarnation(handle)

    runtime.markGraphUnavailable(1)

    expect(runtime.getTerminalProcessIncarnation(handle)).toBe(incarnation)
  })

  it('preserves PTY process identity while a renderer surface detaches and reattaches', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({
        id: 'pty-bg',
        incarnationId: 'incarnation-bg'
      }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    const created = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)
    const [tabId, leafId] = created.paneKey?.split(':') ?? []
    if (!tabId || !leafId) {
      throw new Error('expected stable pane identity')
    }
    const syncSurface = (ptyId: string | null): void => {
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId,
            worktreeId: TEST_WORKTREE_ID,
            title: 'Codex',
            activeLeafId: leafId,
            layout: null
          }
        ],
        leaves: [
          {
            tabId,
            worktreeId: TEST_WORKTREE_ID,
            leafId,
            paneRuntimeId: 1,
            ptyId,
            paneTitle: 'Codex'
          }
        ]
      })
    }

    syncSurface('pty-bg')
    await runtime.listTerminals()
    const before = runtime.getTerminalProcessIncarnation(created.handle)
    syncSurface(null)
    syncSurface('pty-bg')
    await runtime.listTerminals()

    expect(runtime.getTerminalProcessIncarnation(created.handle)).toBe(before)

    runtime.registerPty('pty-bg', TEST_WORKTREE_ID, null, {
      tabId,
      leafId,
      incarnationId: 'incarnation-replacement'
    })
    expect(runtime.getTerminalProcessIncarnation(created.handle)).not.toBe(before)
  })
})
