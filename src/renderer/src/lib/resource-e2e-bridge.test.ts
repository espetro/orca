import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type MockWindow = {
  window: Record<string, unknown>
  api: {
    resources?: {
      dump: () => Promise<unknown>
      mark: (name: string) => void
    }
  }
}

function installGlobals(withApiResources: boolean): MockWindow {
  const mockWindow: MockWindow = {
    window: {},
    api: withApiResources
      ? {
          resources: {
            dump: vi.fn(() => Promise.resolve({ schema: 'orca.resource-dump' })),
            mark: vi.fn()
          }
        }
      : {}
  }
  vi.stubGlobal('window', {
    ...mockWindow.window,
    api: mockWindow.api
  })
  return mockWindow
}

vi.mock('./e2e-config', () => ({
  e2eConfig: { exposeStore: false }
}))

describe('resource e2e bridge', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./e2e-config')
  })

  it('does not define the global when exposeStore is false', async () => {
    installGlobals(true)
    const { installResourceE2EBridge } = await import('./resource-e2e-bridge')
    installResourceE2EBridge()
    expect(window).not.toHaveProperty('__orcaE2E__')
  })

  it('installs resources.dump and resources.mark when exposeStore is true', async () => {
    installGlobals(true)
    vi.doMock('./e2e-config', () => ({ e2eConfig: { exposeStore: true } }))
    const { installResourceE2EBridge } = await import('./resource-e2e-bridge')
    installResourceE2EBridge()
    const bridge = (
      window as unknown as {
        __orcaE2E__: { resources: { dump: () => Promise<unknown>; mark: (n: string) => void } }
      }
    ).__orcaE2E__
    expect(Object.keys(bridge)).toEqual(['resources'])
    expect(Object.keys(bridge.resources)).toEqual(['dump', 'mark'])
    const dump = await bridge.resources.dump()
    expect(dump).toEqual({ schema: 'orca.resource-dump' })
    bridge.resources.mark('fixture-ready')
    expect((window as unknown as MockWindow).api.resources?.mark).toHaveBeenCalledWith(
      'fixture-ready'
    )
  })

  it('rejects dump with recorder-disabled when preload exposes no resources namespace', async () => {
    installGlobals(false)
    vi.doMock('./e2e-config', () => ({ e2eConfig: { exposeStore: true } }))
    const { installResourceE2EBridge } = await import('./resource-e2e-bridge')
    installResourceE2EBridge()
    const bridge = (
      window as unknown as {
        __orcaE2E__: { resources: { dump: () => Promise<unknown> } }
      }
    ).__orcaE2E__
    await expect(bridge.resources.dump()).rejects.toThrow('recorder-disabled')
  })
})
