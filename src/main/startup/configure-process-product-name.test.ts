import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const paths = new Map<string, string>([['appData', '/tmp/app-data']])
  return {
    app: {
      getPath: vi.fn((name: string) => paths.get(name) ?? ''),
      setPath: vi.fn((name: string, value: string) => {
        paths.set(name, value)
      }),
      quit: vi.fn(),
      exit: vi.fn(),
      isPackaged: false,
      disableHardwareAcceleration: vi.fn(),
      commandLine: {
        appendSwitch: vi.fn(),
        getSwitchValue: vi.fn(() => '')
      }
    }
  }
})

describe('configureDevUserDataPath', () => {
  it('uses explicit ORCA_USER_DATA_PATH_OVERRIDE when set', async () => {
    const { app } = await import('electron')
    const { configureDevUserDataPath } = await import('./configure-process')
    const originalOverride = process.env.ORCA_USER_DATA_PATH_OVERRIDE
    process.env.ORCA_USER_DATA_PATH_OVERRIDE = '/tmp/orca-override'

    try {
      configureDevUserDataPath(false)
    } finally {
      if (originalOverride === undefined) {
        delete process.env.ORCA_USER_DATA_PATH_OVERRIDE
      } else {
        process.env.ORCA_USER_DATA_PATH_OVERRIDE = originalOverride
      }
    }

    expect(app.setPath).toHaveBeenCalledWith('userData', '/tmp/orca-override')
  })

  it('uses baked product name for packaged userData path when set and not Orca', async () => {
    const { app } = await import('electron')
    const { configureDevUserDataPath } = await import('./configure-process')
    const g = globalThis as typeof globalThis & { ORCA_PRODUCT_NAME?: string | null }
    g.ORCA_PRODUCT_NAME = 'Orca Canary'

    try {
      vi.mocked(app.setPath).mockClear()
      configureDevUserDataPath(false)
    } finally {
      delete g.ORCA_PRODUCT_NAME
    }

    expect(app.setPath).toHaveBeenCalledWith('userData', join('/tmp/app-data', 'Orca Canary'))
  })
})
