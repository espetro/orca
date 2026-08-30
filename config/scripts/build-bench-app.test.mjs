import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createBenchBuild,
  isNativeModuleUpToDate,
  parseArgs,
  verifyStoreExposure
} from './build-bench-app.mjs'

const repoRoot = path.resolve(import.meta.dirname, '../..')

const MODULE = {
  script: 'build:keyboard-layout-macos',
  sourceDir: '/tmp/src',
  artifacts: ['/tmp/.build/out']
}

function fakeStatTree(files) {
  return (filePath) => ({
    mtimeMs:
      files[filePath] ??
      (() => {
        throw new Error(`unexpected stat: ${filePath}`)
      })()
  })
}

describe('parseArgs', () => {
  it('detects --renderer-only', () => {
    expect(parseArgs(['--renderer-only']).rendererOnly).toBe(true)
    expect(parseArgs([]).rendererOnly).toBe(false)
  })
})

describe('isNativeModuleUpToDate', () => {
  it('is stale when an artifact is missing', () => {
    const deps = {
      statSync: vi.fn(),
      existsSync: vi.fn((p) => p !== MODULE.artifacts[0])
    }
    expect(isNativeModuleUpToDate(MODULE, deps)).toBe(false)
  })

  it('is stale when any source is newer than the artifacts', () => {
    const deps = {
      statSync: fakeStatTree({
        [MODULE.artifacts[0]]: 100,
        '/tmp/src/main.swift': 200
      }),
      existsSync: () => true,
      readdirSync: () => [{ name: 'main.swift', isDirectory: () => false }]
    }
    expect(isNativeModuleUpToDate(MODULE, deps)).toBe(false)
  })

  it('is up to date when artifacts are newer than every source', () => {
    const deps = {
      statSync: fakeStatTree({
        [MODULE.artifacts[0]]: 300,
        '/tmp/src/main.swift': 200,
        '/tmp/src/other.swift': 299
      }),
      existsSync: () => true,
      readdirSync: () => [
        { name: 'main.swift', isDirectory: () => false },
        { name: 'other.swift', isDirectory: () => false },
        { name: '.build', isDirectory: () => true }
      ]
    }
    expect(isNativeModuleUpToDate(MODULE, deps)).toBe(true)
  })
})

describe('verifyStoreExposure', () => {
  it('fails on zero matches', () => {
    expect(verifyStoreExposure(0)).toBe(false)
  })

  it('passes on any non-zero count', () => {
    expect(verifyStoreExposure(1)).toBe(true)
    expect(verifyStoreExposure(17)).toBe(true)
  })
})

describe('createBenchBuild', () => {
  const assetsDir = mkdtempSync(path.join(tmpdir(), 'bench-assets-'))
  writeFileSync(path.join(assetsDir, 'store-abc123.js'), 'const x = { __store: 1 }')

  function recordingRunner(failures = []) {
    const calls = []
    const runner = (cmd, args, options) => {
      calls.push({ cmd, args, options })
      const invoked = args[0] ?? cmd
      if (failures.some((f) => invoked.endsWith(f))) {
        return { status: 1, stdout: '' }
      }
      return { status: 0, stdout: '5' }
    }
    return { calls, runner }
  }

  it('runs vite with VITE_EXPOSE_STORE and prints packaged app path on stdout', async () => {
    const { calls, runner } = recordingRunner()
    const chunks = []
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
      chunks.push(String(c))
      return true
    })
    try {
      await createBenchBuild({
        runner,
        env: {},
        rendererAssetsDir: assetsDir
      }).run()
    } finally {
      stdout.mockRestore()
    }
    const viteCall = calls.find((c) => c.args[0]?.endsWith('run-electron-vite-build.mjs'))
    expect(viteCall.options.env.VITE_EXPOSE_STORE).toBe('true')
    const builderCall = calls.find((c) => c.cmd === 'pnpm' && c.args.includes('--dir'))
    expect(builderCall).toBeDefined()
    expect(chunks.join('')).toContain(path.join(repoRoot, 'dist', 'mac-arm64', 'Orca.app'))
    expect(calls.some((c) => c.cmd === 'grep' && c.args.includes('__store'))).toBe(true)
  })

  it('skips native builds entirely with --renderer-only', async () => {
    const { calls, runner } = recordingRunner()
    const originalArgv = process.argv
    process.argv = ['node', 'build-bench-app.mjs', '--renderer-only']
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await createBenchBuild({ runner, env: {}, rendererAssetsDir: assetsDir }).run()
    } finally {
      process.argv = originalArgv
      vi.mocked(process.stdout.write).mockRestore()
    }
    expect(calls.some((c) => c.cmd === 'node' && c.args[0] === '-e')).toBe(false)
    expect(calls.some((c) => c.args[0]?.endsWith('run-electron-vite-build.mjs'))).toBe(true)
  })

  it('propagates child failure as a thrown error', async () => {
    const { runner } = recordingRunner(['run-electron-vite-build.mjs'])
    await expect(
      createBenchBuild({ runner, env: {}, rendererAssetsDir: assetsDir }).run()
    ).rejects.toThrow(/electron-vite build failed/)
  })

  it('throws the loud store-exposure error when grep finds nothing', async () => {
    const runner = () => ({ status: 0, stdout: '0' })
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await expect(
        createBenchBuild({ runner, env: {}, rendererAssetsDir: assetsDir }).run()
      ).rejects.toThrow(/VITE_EXPOSE_STORE was likely missing/)
    } finally {
      vi.mocked(process.stdout.write).mockRestore()
    }
  })

  it('up-to-date modules skip their native pnpm invocation', async () => {
    const { calls, runner } = recordingRunner()
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await createBenchBuild({
        runner,
        env: {},
        rendererAssetsDir: assetsDir,
        isUpToDate: () => true
      }).run()
    } finally {
      vi.mocked(process.stdout.write).mockRestore()
    }
    expect(calls.some((c) => c.cmd === 'node' && c.args[0] === '-e')).toBe(false)
  })
})
