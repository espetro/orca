import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'

const { execFileMock, hostMemoryMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  hostMemoryMock: vi.fn()
}))

async function loadRecorder() {
  vi.resetModules()
  return import('./resource-recorder')
}

type RecorderModule = Awaited<ReturnType<typeof loadRecorder>>

function makeRecorder(module: RecorderModule, overrides: Record<string, unknown> = {}) {
  let time = 1_000
  return module.createResourceRecorder({
    tickMs: 1_000,
    ringCapacity: 3,
    now: () => (time += 1),
    execFile: execFileMock,
    hostMemory: hostMemoryMock,
    getAppMetrics: () => [
      {
        pid: 111,
        type: 'Browser',
        cpu: { percentCPUUsage: 1.5 },
        memory: { workingSetSize: 20_480 }
      },
      { pid: 222, type: 'Tab', cpu: { percentCPUUsage: 0.5 }, memory: { workingSetSize: 10_240 } }
    ],
    ...overrides
  })
}

const PS_STDOUT = '  111  51200\n  222  25600\n'
const FOOTPRINT_STDOUT =
  'Footprint: 1361 KB (16384 bytes per page)\n    phys_footprint: 1361 KB\n ...table...'
const THERMAL_STDOUT = 'CPU_Speed_Limit = 100\n'
const VM_STAT_1 = 'Page ins: 1000.\nPage outs: 500.\n'
const VM_STAT_2 = 'Page ins: 1030.\nPage outs: 505.\n'

describe('resource recorder', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useFakeTimers()
    execFileMock.mockReset()
    hostMemoryMock.mockReset()
    vi.spyOn(os, 'platform').mockReturnValue('darwin')
    vi.spyOn(process, 'memoryUsage').mockReturnValue({
      rss: 10,
      heapUsed: 2,
      heapTotal: 4,
      external: 1,
      arrayBuffers: 0
    })
    execFileMock.mockImplementation((file: string) => {
      if (file === 'ps') {
        return Promise.resolve({ stdout: PS_STDOUT, stderr: '' })
      }
      if (file === 'pmset') {
        return Promise.resolve({ stdout: THERMAL_STDOUT, stderr: '' })
      }
      if (file === 'vm_stat') {
        return Promise.resolve({ stdout: VM_STAT_2, stderr: '' })
      }
      if (file === '/usr/bin/footprint') {
        return Promise.resolve({ stdout: FOOTPRINT_STDOUT, stderr: '' })
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    })
    hostMemoryMock.mockResolvedValue({
      availableMemory: 8_589_934_592,
      availableMemorySource: 'memory-pressure',
      loadAverage1m: 2.5
    })
    delete process.env.ORCA_RESOURCE_RECORDER
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('records a tick with samples, host context, and main-process memory', async () => {
    const module = await loadRecorder()
    const recorder = makeRecorder(module)

    recorder.start()
    await vi.advanceTimersByTimeAsync(0)

    const dump = recorder.dump()
    expect(dump.schema).toBe('orca.resource-dump')
    expect(dump.schemaVersion).toBe(1)
    expect(dump.ticks).toHaveLength(1)

    const tick = dump.ticks[0]
    expect(tick.samples).toHaveLength(2)
    expect(tick.samples[0]).toMatchObject({
      pid: 111,
      type: 'main',
      rssBytes: 52_428_800,
      footprintBytes: 1_393_664,
      cpuPercent: 1.5
    })
    expect(tick.samples[1].type).toBe('renderer')
    expect(tick.host).toMatchObject({
      availableMemoryBytes: 8_589_934_592,
      availableMemorySource: 'memory-pressure',
      loadAverage1m: 2.5,
      thermal: { cpuSpeedLimitPercent: 100 }
    })
    expect(tick.mainProcess).toEqual({
      rssBytes: 10,
      heapUsedBytes: 2,
      heapTotalBytes: 4,
      externalBytes: 1
    })
    expect(dump.hostSamples).toEqual(dump.ticks.map((t) => t.host))
    recorder.stop()
  })

  it('runs one batched ps exec and one footprint probe per sample per tick', async () => {
    const module = await loadRecorder()
    const recorder = makeRecorder(module)

    recorder.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000)

    const psCalls = execFileMock.mock.calls.filter((call) => call[0] === 'ps')
    expect(psCalls).toHaveLength(2)
    expect(psCalls[0][1]).toEqual(['-o', 'pid=,rss=', '-p', '111,222'])
    const footprintCalls = execFileMock.mock.calls.filter(
      (call) => call[0] === '/usr/bin/footprint'
    )
    expect(footprintCalls).toHaveLength(4)
    expect(footprintCalls[0][1]).toEqual(['-p', '111'])
    recorder.stop()
  })

  it('computes vm_stat deltas against the previous tick', async () => {
    let vmStatCall = 0
    execFileMock.mockImplementation((file: string) => {
      if (file === 'vm_stat') {
        vmStatCall += 1
        return Promise.resolve({ stdout: vmStatCall === 1 ? VM_STAT_1 : VM_STAT_2, stderr: '' })
      }
      if (file === 'ps') {
        return Promise.resolve({ stdout: PS_STDOUT, stderr: '' })
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    })
    const module = await loadRecorder()
    const recorder = makeRecorder(module)

    recorder.start()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000)

    const dump = recorder.dump()
    expect(dump.ticks[0].host.pageinsDelta).toBeNull()
    expect(dump.ticks[1].host).toMatchObject({ pageinsDelta: 30, pageoutsDelta: 5 })
    recorder.stop()
  })

  it('marks footprintBytes null on all samples when the footprint tool fails', async () => {
    execFileMock.mockImplementation((file: string) => {
      if (file === 'ps') {
        return Promise.resolve({ stdout: PS_STDOUT, stderr: '' })
      }
      if (file === '/usr/bin/footprint') {
        return Promise.reject(new Error('footprint failed'))
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    })
    const module = await loadRecorder()
    const recorder = makeRecorder(module)

    recorder.start()
    await vi.advanceTimersByTimeAsync(0)

    const sample = recorder.dump().ticks[0].samples[0]
    expect(sample.footprintBytes).toBeNull()
    recorder.stop()
  })

  it('bounds the ring buffer and markers at ringCapacity', async () => {
    const module = await loadRecorder()
    const recorder = makeRecorder(module, { ringCapacity: 3 })

    recorder.start()
    await vi.advanceTimersByTimeAsync(5_000)
    recorder.mark('m1')
    recorder.mark('m2')
    recorder.mark('m3')
    recorder.mark('m4')

    const dump = recorder.dump()
    expect(dump.ticks.length).toBeLessThanOrEqual(3)
    expect(dump.ticks.at(-1)).toBeDefined()
    expect(dump.markers).toHaveLength(3)
    expect(dump.markers[0].name).toBe('m2')
    recorder.stop()
  })

  it('stop prevents further ticks and isRunning reflects state', async () => {
    const module = await loadRecorder()
    const recorder = makeRecorder(module)

    expect(recorder.isRunning()).toBe(false)
    recorder.start()
    expect(recorder.isRunning()).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    recorder.stop()
    expect(recorder.isRunning()).toBe(false)

    const before = recorder.dump().ticks.length
    await vi.advanceTimersByTimeAsync(5_000)
    expect(recorder.dump().ticks.length).toBe(before)
  })

  it('mark appends a named marker with timestamp', async () => {
    const module = await loadRecorder()
    const recorder = makeRecorder(module)

    recorder.mark('fixture-ready')

    const [marker] = recorder.dump().markers
    expect(marker.name).toBe('fixture-ready')
    expect(typeof marker.timestamp).toBe('number')
  })

  it('skips ps/thermal/vm_stat off darwin', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('linux')
    const module = await loadRecorder()
    const recorder = makeRecorder(module)

    recorder.start()
    await vi.advanceTimersByTimeAsync(0)

    expect(execFileMock).not.toHaveBeenCalled()
    const tick = recorder.dump().ticks[0]
    expect(tick.host.thermal).toBeNull()
    expect(tick.host.pageinsDelta).toBeNull()
    expect(tick.samples[0].footprintBytes).toBeNull()
    recorder.stop()
  })

  it('startResourceRecorderIfEnabled respects the env flag', async () => {
    const module = await loadRecorder()
    expect(module.startResourceRecorderIfEnabled()).toBeNull()
    expect(module.getResourceRecorder()).toBeNull()

    process.env.ORCA_RESOURCE_RECORDER = '1'
    execFileMock.mockImplementation((file: string) => {
      if (file === 'ps') {
        return Promise.resolve({ stdout: PS_STDOUT, stderr: '' })
      }
      return Promise.resolve({ stdout: '', stderr: '' })
    })
    const recorder = module.startResourceRecorderIfEnabled()
    expect(recorder).not.toBeNull()
    expect(module.getResourceRecorder()).toBe(recorder)
    expect(recorder?.isRunning()).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    module.resetResourceRecorderForTests()
    expect(module.getResourceRecorder()).toBeNull()
  })

  it('dump works without electron installed', async () => {
    const module = await loadRecorder()
    const recorder = makeRecorder(module)

    expect(() => recorder.dump()).not.toThrow()
    expect(recorder.dump().appVersion).toBeTruthy()
  })
})
