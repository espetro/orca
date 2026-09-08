import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'
import { configureSessionCodeCache, enableMainProcessCompileCache } from './native-code-cache'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => `/mock/user/data/${name}`)
  }
}))

describe('enableMainProcessCompileCache', () => {
  const originalEnv = process.env.NODE_COMPILE_CACHE

  beforeEach(() => {
    delete process.env.NODE_COMPILE_CACHE
  })

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.NODE_COMPILE_CACHE = originalEnv
    } else {
      delete process.env.NODE_COMPILE_CACHE
    }
    vi.restoreAllMocks()
  })

  it('enables compile cache and sets process.env.NODE_COMPILE_CACHE', () => {
    const result = enableMainProcessCompileCache('/tmp/mock-cache')
    expect(result.enabled).toBe(true)
    expect(result.directory).toBeTruthy()
    expect(process.env.NODE_COMPILE_CACHE).toBe(result.directory)
  })

  it('safely handles missing cache dir fallback', () => {
    const result = enableMainProcessCompileCache()
    expect(result.enabled).toBe(true)
    expect(result.directory).toBeTruthy()
  })
})

describe('configureSessionCodeCache', () => {
  it('calls setCodeCachePath on the target session with app userData Code Cache path', () => {
    const mockSession: Pick<Session, 'setCodeCachePath'> = {
      setCodeCachePath: vi.fn()
    }

    const configured = configureSessionCodeCache(mockSession)
    expect(configured).toBe(true)
    expect(mockSession.setCodeCachePath).toHaveBeenCalledWith('/mock/user/data/userData/Code Cache')
  })

  it('returns false gracefully if setCodeCachePath throws or is missing', () => {
    expect(configureSessionCodeCache({} as Pick<Session, 'setCodeCachePath'>)).toBe(false)
  })
})
