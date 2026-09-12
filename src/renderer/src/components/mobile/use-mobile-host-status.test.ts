// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileHostStatus } from './use-mobile-host-status'

const mocks = vi.hoisted(() => ({
  callRuntimeResult: vi.fn()
}))

vi.mock('@/web/preload-api/web-runtime-calls', () => ({
  callRuntimeResult: mocks.callRuntimeResult
}))

import { useMobileHostStatus, type MobileHostStatusState } from './use-mobile-host-status'
import type { RuntimeDesktopWindowStatus } from '../../../../shared/runtime-session-contracts'

let latest: MobileHostStatusState | null = null

function Probe(): null {
  // Why: tests capture the rendered state by reassigning the module-level `latest`
  // during the same commit that produces the state. This mirrors the pattern in
  // use-mobile-page-paired-devices.test.ts.
  latest = useMobileHostStatus()
  return null
}

const mountedRoots: Root[] = []

async function renderProbe(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)
  await act(async () => {
    root.render(createElement(Probe))
  })
}

async function unmountProbes(): Promise<void> {
  await act(async () => {
    for (const root of mountedRoots.splice(0)) {
      root.unmount()
    }
  })
}

describe('useMobileHostStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    latest = null
  })

  afterEach(async () => {
    await unmountProbes()
    document.body.innerHTML = ''
  })

  it('starts in the loading state before the RPC resolves', async () => {
    let resolveCall: ((value: MobileHostStatus) => void) | undefined
    mocks.callRuntimeResult.mockImplementation(
      () =>
        new Promise<MobileHostStatus>((resolve) => {
          resolveCall = resolve
        })
    )

    await renderProbe()

    expect(mocks.callRuntimeResult).toHaveBeenCalledWith('mobile.hostStatus')
    expect(latest).toEqual({ state: 'loading' })

    const expected = {
      state: 'loaded' as const,
      status: {
        desktopWindowStatus: 'available' as RuntimeDesktopWindowStatus,
        hostMode: 'desktop' as const,
        relayAvailable: true,
        webSocketEndpoint: 'ws://host:9223'
      }
    }
    await act(async () => {
      resolveCall?.(expected.status)
    })
    expect(latest).toEqual(expected)
  })

  it('returns loaded once the host replies with a status', async () => {
    const status: MobileHostStatus = {
      desktopWindowStatus: 'blocked',
      hostMode: 'serve',
      relayAvailable: false,
      webSocketEndpoint: null
    }
    mocks.callRuntimeResult.mockResolvedValue(status)

    await renderProbe()
    await act(async () => {
      await Promise.resolve()
    })

    expect(latest).toEqual({ state: 'loaded', status })
  })

  it('returns unavailable when the host rejects the RPC (older build)', async () => {
    mocks.callRuntimeResult.mockRejectedValue(
      Object.assign(new Error('method_not_found'), { code: 'method_not_found' })
    )

    await renderProbe()
    await act(async () => {
      await Promise.resolve()
    })

    expect(latest).toEqual({ state: 'unavailable' })
  })

  it('does not update state after unmount (no leak into the next test)', async () => {
    const status: MobileHostStatus = {
      desktopWindowStatus: 'available',
      hostMode: 'desktop',
      relayAvailable: true,
      webSocketEndpoint: 'ws://host:9223'
    }
    let resolveCall: ((value: MobileHostStatus) => void) | undefined
    mocks.callRuntimeResult.mockImplementation(
      () =>
        new Promise<MobileHostStatus>((resolve) => {
          resolveCall = resolve
        })
    )

    await renderProbe()
    // Capture the value at the moment of unmount — the cancelled flag must prevent
    // any later setState from overwriting it.
    const valueAtUnmount = latest
    await unmountProbes()

    // Why: the cancelled flag must guard against late responses painting state on
    // an unmounted hook. Resolving after unmount must NOT reach the (now detached) hook,
    // and our probe component has stopped rendering too — so `latest` retains its last
    // value and is not overwritten to a `loaded` state.
    resolveCall?.(status)
    await act(async () => {
      await Promise.resolve()
    })
    expect(latest).toBe(valueAtUnmount)
    expect(latest).toEqual({ state: 'loading' })
  })
})
