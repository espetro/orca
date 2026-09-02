import { join } from 'node:path'
import type { Session } from 'electron'
import { app } from 'electron'

export type NativeCodeCacheResult = {
  enabled: boolean
  directory: string | null
  error?: string
}

// Why: persist compiled V8 bytecode to disk so warm launches bypass JS parsing and AST allocation spikes.
export function enableMainProcessCompileCache(customCacheDir?: string): NativeCodeCacheResult {
  try {
    const nodeModule = require('node:module') as {
      enableCompileCache?: (dir?: string) => { status: number; directory: string }
    }

    if (typeof nodeModule.enableCompileCache !== 'function') {
      return { enabled: false, directory: null }
    }

    const cacheDir =
      customCacheDir ??
      process.env.NODE_COMPILE_CACHE ??
      (typeof app?.getPath === 'function'
        ? join(app.getPath('userData'), 'compile-cache')
        : undefined)

    const result = nodeModule.enableCompileCache(cacheDir)
    if (result && result.directory) {
      // Why: child processes (daemon, plugin-host, watcher) inherit env and automatically use compile cache.
      process.env.NODE_COMPILE_CACHE = result.directory
      return { enabled: true, directory: result.directory }
    }

    return { enabled: false, directory: null }
  } catch (error) {
    return {
      enabled: false,
      directory: null,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

// Why: ensure Chromium session stores compiled web script bytecode persistently in user profile.
export function configureSessionCodeCache(
  targetSession: Pick<Session, 'setCodeCachePath'>
): boolean {
  try {
    if (
      typeof targetSession?.setCodeCachePath === 'function' &&
      typeof app?.getPath === 'function'
    ) {
      const codeCachePath = join(app.getPath('userData'), 'Code Cache')
      targetSession.setCodeCachePath(codeCachePath)
      return true
    }
    return false
  } catch {
    return false
  }
}
