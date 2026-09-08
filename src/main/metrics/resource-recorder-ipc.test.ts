import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ipcHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
let recorder: { dump: ReturnType<typeof vi.fn>; mark: ReturnType<typeof vi.fn> } | null

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler)
    })
  }
}))

vi.mock('./resource-recorder', () => ({
  getResourceRecorder: () => recorder
}))

function invoke(channel: string, ...args: unknown[]): unknown {
  const handler = ipcHandlers.get(channel)
  if (!handler) {
    throw new Error(`no handler for ${channel}`)
  }
  return handler({}, ...args)
}

describe('resource recorder ipc handlers', () => {
  beforeEach(() => {
    vi.resetModules()
    ipcHandlers.clear()
    recorder = null
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('registers dump and mark handlers', async () => {
    const { installResourceRecorderIpcHandlers } = await import('./resource-recorder-ipc')
    installResourceRecorderIpcHandlers()
    expect([...ipcHandlers.keys()]).toEqual(['resources:dump', 'resources:mark'])
  })

  it('rejects dump with recorder-disabled when no recorder exists', async () => {
    const { installResourceRecorderIpcHandlers } = await import('./resource-recorder-ipc')
    installResourceRecorderIpcHandlers()
    expect(() => invoke('resources:dump')).toThrow('recorder-disabled')
  })

  it('rejects mark with recorder-disabled when no recorder exists', async () => {
    const { installResourceRecorderIpcHandlers } = await import('./resource-recorder-ipc')
    installResourceRecorderIpcHandlers()
    expect(() => invoke('resources:mark', 'fixture-ready')).toThrow('recorder-disabled')
  })

  it('forwards dump to the recorder', async () => {
    const dump = vi.fn(() => ({ schema: 'orca.resource-dump' }))
    recorder = { dump, mark: vi.fn() }
    const { installResourceRecorderIpcHandlers } = await import('./resource-recorder-ipc')
    installResourceRecorderIpcHandlers()
    expect(invoke('resources:dump')).toEqual({ schema: 'orca.resource-dump' })
    expect(dump).toHaveBeenCalledTimes(1)
  })

  it('forwards mark names to the recorder', async () => {
    const mark = vi.fn()
    recorder = { dump: vi.fn(), mark }
    const { installResourceRecorderIpcHandlers } = await import('./resource-recorder-ipc')
    installResourceRecorderIpcHandlers()
    invoke('resources:mark', 'fixture-ready')
    expect(mark).toHaveBeenCalledWith('fixture-ready')
  })
})
