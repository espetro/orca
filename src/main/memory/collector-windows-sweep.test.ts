import { beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import type { MemorySnapshotStore } from './collector'
import { setAppEnvironment } from '../../shared/app-environment'
import type { WindowsProcessRow } from '../windows/windows-process-table'

type AppMetricFixture = {
  pid: number
  type: string
  cpu: { percentCPUUsage: number }
  memory: { workingSetSize: number }
}

const { appMetricsMock, runProcessMock, execMock, listRegisteredPtysMock, readTableMock } =
  vi.hoisted(() => ({
    appMetricsMock: vi.fn<() => AppMetricFixture[]>(() => []),
    runProcessMock: vi.fn(),
    execMock: vi.fn(),
    listRegisteredPtysMock: vi.fn(),
    readTableMock: vi.fn<() => Promise<WindowsProcessRow[]>>()
  }))

vi.mock('child_process', () => ({
  exec: (cmd: string, opts: unknown, cb: (err: Error | null, out: { stdout: string }) => void) =>
    execMock(cmd, opts, cb)
}))

// Why mock the seam rather than assert on a program spec: the sweep must spawn
// no child process at all, so every suite below asserts the mock stays cold.
vi.mock('../../shared/child-process/run-process', () => ({
  runProcess: (spec: { program: string; args?: string[] }) => runProcessMock(spec)
}))

vi.mock('../windows/windows-process-table', () => ({
  readWindowsProcessTable: () => readTableMock()
}))

vi.mock('./pty-registry', () => ({
  listRegisteredPtys: listRegisteredPtysMock
}))

function appEnvironment() {
  return {
    getPath: () => process.cwd(),
    getAppPath: () => process.cwd(),
    getVersion: () => '0.0.0-test',
    isPackaged: () => false,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: appMetricsMock
  }
}

async function loadCollector() {
  vi.resetModules()
  const { setAppEnvironment: setResetAppEnvironment } = await import('../../shared/app-environment')
  setResetAppEnvironment(appEnvironment())
  return await import('./collector')
}

const emptyStore = {
  getWorktreeMeta: () => undefined,
  getRepo: () => undefined
} satisfies MemorySnapshotStore

function nativeRow(partial: Partial<WindowsProcessRow> & { pid: number }): WindowsProcessRow {
  return { ppid: 1, name: 'fixture.exe', command: '', ...partial }
}

describe('collectMemorySnapshot on Windows', () => {
  beforeEach(() => {
    setAppEnvironment(appEnvironment())
    vi.restoreAllMocks()
    appMetricsMock.mockReset()
    appMetricsMock.mockReturnValue([])
    runProcessMock.mockReset()
    execMock.mockReset()
    listRegisteredPtysMock.mockReset()
    listRegisteredPtysMock.mockReturnValue([])
    readTableMock.mockReset()
    readTableMock.mockResolvedValue([])
  })

  function mockPsResponse(stdout: string) {
    execMock.mockImplementation((_cmd, _opts, cb) => cb(null, { stdout, stderr: '' }))
  }

  it('reads the native process table without spawning any child process', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32')
    readTableMock.mockResolvedValue([nativeRow({ pid: 10, ppid: 1, memoryBytes: 1024 * 1024 })])
    listRegisteredPtysMock.mockReturnValue([
      {
        ptyId: 'native-pty',
        worktreeId: 'repo-1::C:\\repo',
        sessionId: 'session-1',
        paneKey: 'pane-1',
        pid: 10
      }
    ])
    const { collectMemorySnapshot } = await loadCollector()

    const snapshot = await collectMemorySnapshot(emptyStore)

    expect(runProcessMock).not.toHaveBeenCalled()
    expect(execMock).not.toHaveBeenCalled()
    expect(readTableMock).toHaveBeenCalledTimes(1)
    expect(snapshot.worktrees[0].sessions[0]).toMatchObject({ cpu: 0, memory: 1024 * 1024 })
  })

  it('clamps an absent working set to zero rather than dropping the row', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32')
    readTableMock.mockResolvedValue([
      nativeRow({ pid: 10 }),
      nativeRow({ pid: 11, ppid: 10, memoryBytes: 0 })
    ])
    listRegisteredPtysMock.mockReturnValue([
      {
        ptyId: 'no-memory-pty',
        worktreeId: 'repo-1::C:\\repo',
        sessionId: 'session-1',
        paneKey: 'pane-1',
        pid: 10
      }
    ])
    const { collectMemorySnapshot } = await loadCollector()

    const snapshot = await collectMemorySnapshot(emptyStore)

    expect(snapshot.worktrees[0].sessions[0].memory).toBe(0)
    expect(snapshot.totalMemory).toBe(0)
  })

  it('returns an empty sweep when the process table rejects', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    readTableMock.mockRejectedValue(new Error('windows process table is unreadable'))
    listRegisteredPtysMock.mockReturnValue([
      {
        ptyId: 'failed-pty',
        worktreeId: 'repo-1::C:\\repo',
        sessionId: 'session-1',
        paneKey: 'pane-1',
        pid: 10
      }
    ])
    const { collectMemorySnapshot } = await loadCollector()

    const snapshot = await collectMemorySnapshot(emptyStore)

    expect(snapshot.worktrees[0].sessions[0]).toMatchObject({ cpu: 0, memory: 0 })
    expect(snapshot.processMemoryMetric).toBe('working-set')
  })

  it('carries no commit metric on the native path, where the table cannot report it', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32')
    readTableMock.mockResolvedValue([nativeRow({ pid: 10, memoryBytes: 52428800 })])
    listRegisteredPtysMock.mockReturnValue([
      {
        ptyId: 'pty-1',
        worktreeId: 'repo-1::C:\\repo',
        sessionId: 'session-1',
        paneKey: 'pane-1',
        pid: 10
      }
    ])
    const { collectMemorySnapshot } = await loadCollector()

    const snapshot = await collectMemorySnapshot(emptyStore)

    // Why not zero: a host that cannot measure commit must be distinguishable
    // from agents that hold none.
    expect(snapshot.processCommitMetric).toBeUndefined()
    expect(snapshot.totalPrivateMemory).toBeUndefined()
    expect(snapshot.worktrees[0].privateMemory).toBeUndefined()
    expect(snapshot.worktrees[0].sessions[0].privateMemory).toBeUndefined()
    expect(snapshot.app.privateMemory).toBeUndefined()
    expect(snapshot.totalMemory).toBe(52428800)
  })

  it('attributes Electron processes from the same native table read', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('win32')
    readTableMock.mockResolvedValue([nativeRow({ pid: 900, memoryBytes: 20971520 })])
    appMetricsMock.mockReturnValue([
      { pid: 900, type: 'Browser', cpu: { percentCPUUsage: 12 }, memory: { workingSetSize: 0 } }
    ])
    const { collectMemorySnapshot } = await loadCollector()

    const snapshot = await collectMemorySnapshot(emptyStore)

    expect(snapshot.app.main).toMatchObject({ cpu: 12, memory: 20971520 })
    expect(readTableMock).toHaveBeenCalledTimes(1)
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('carries no commit metric on Unix, where ps has no committed-bytes column', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin')
    mockPsResponse('10 1 0 1024')
    listRegisteredPtysMock.mockReturnValue([
      {
        ptyId: 'pty-1',
        worktreeId: 'repo-1::/repo',
        sessionId: 'session-1',
        paneKey: 'pane-1',
        pid: 10
      }
    ])
    const { collectMemorySnapshot } = await loadCollector()

    const snapshot = await collectMemorySnapshot(emptyStore)

    expect(snapshot.processMemoryMetric).toBe('rss')
    expect(snapshot.processCommitMetric).toBeUndefined()
    expect(snapshot.totalPrivateMemory).toBeUndefined()
    expect(snapshot.worktrees[0].sessions[0].privateMemory).toBeUndefined()
  })
})
