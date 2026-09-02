import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  computeBenchInputsHash,
  createBenchBuild,
  getBenchHashFilePath,
  isBenchBuildUpToDate,
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

  it('detects --skip-unchanged', () => {
    expect(parseArgs(['--skip-unchanged']).skipUnchanged).toBe(true)
    expect(parseArgs([]).skipUnchanged).toBe(false)
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

describe('computeBenchInputsHash', () => {
  it('hashes relative path plus file content', () => {
    const files = {
      '/repo/src/a.ts': 'alpha',
      '/repo/config/x.json': '{}'
    }
    const readdir = (dir) =>
      Object.keys(files)
        .filter((f) => path.dirname(f) === dir)
        .map((name) => ({ name: path.basename(name), isDirectory: () => false }))
    const readFile = (p) => files[p]
    const withReorderedRoots = (roots) =>
      computeBenchInputsHash(roots, {
        readdirSync: readdir,
        readFileSync: readFile,
        repoRoot: '/repo'
      })
    expect(withReorderedRoots(['/repo/src', '/repo/config'])).toBe(
      withReorderedRoots(['/repo/config', '/repo/src'])
    )
    const otherFiles = { ...files, '/repo/src/a.ts': 'beta' }
    expect(
      computeBenchInputsHash(['/repo/src'], {
        readdirSync: readdir,
        readFileSync: (p) => otherFiles[p],
        repoRoot: '/repo'
      })
    ).not.toBe(
      computeBenchInputsHash(['/repo/src'], {
        readdirSync: readdir,
        readFileSync: readFile,
        repoRoot: '/repo'
      })
    )
  })
})

describe('isBenchBuildUpToDate', () => {
  const base = { storedHash: 'h1', computedHash: 'h1', packagedAppDir: '/repo/dist/mac-arm64' }

  it('is fresh only when hashes match and app dir exists', () => {
    expect(isBenchBuildUpToDate(base, { existsSync: () => true })).toBe(true)
    expect(isBenchBuildUpToDate({ ...base, storedHash: 'h0' }, { existsSync: () => true })).toBe(
      false
    )
    expect(isBenchBuildUpToDate({ ...base, computedHash: 'h2' }, { existsSync: () => true })).toBe(
      false
    )
    expect(
      isBenchBuildUpToDate({ ...base, storedHash: undefined }, { existsSync: () => true })
    ).toBe(false)
    expect(isBenchBuildUpToDate(base, { existsSync: () => false })).toBe(false)
  })
})

describe('getBenchHashFilePath', () => {
  it('lives next to the packaged app dir', () => {
    expect(getBenchHashFilePath('/repo')).toBe(
      path.join('/repo', 'dist', 'mac-arm64', '.bench-build-hash.json')
    )
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

  const stateWrites = []

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
        rendererAssetsDir: assetsDir,
        computeInputsHash: () => 'hash-1',
        writeStateFile: (f, c) => stateWrites.push([f, c])
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
      await createBenchBuild({
        runner,
        env: {},
        rendererAssetsDir: assetsDir,
        computeInputsHash: () => 'hash-1',
        writeStateFile: (f, c) => stateWrites.push([f, c])
      }).run()
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
        isUpToDate: () => true,
        computeInputsHash: () => 'hash-1',
        writeStateFile: (f, c) => stateWrites.push([f, c])
      }).run()
    } finally {
      vi.mocked(process.stdout.write).mockRestore()
    }
    expect(calls.some((c) => c.cmd === 'node' && c.args[0] === '-e')).toBe(false)
  })

  it('rewrites the state file after a real build', () => {
    expect(stateWrites).toHaveLength(3)
    const [file, content] = stateWrites[0]
    expect(file).toBe(getBenchHashFilePath(repoRoot))
    expect(JSON.parse(content)).toEqual({
      hash: 'hash-1',
      appPath: path.join(repoRoot, 'dist', 'mac-arm64', 'Orca.app')
    })
  })

  it('skips the whole build when --skip-unchanged and hash matches', async () => {
    const { calls, runner } = recordingRunner()
    const originalArgv = process.argv
    process.argv = ['node', 'build-bench-app.mjs', '--skip-unchanged']
    const chunks = []
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
      chunks.push(String(c))
      return true
    })
    try {
      await createBenchBuild({
        runner,
        env: {},
        rendererAssetsDir: assetsDir,
        readStateFile: () => ({ hash: 'same', appPath: 'ignored' }),
        computeInputsHash: () => 'same',
        isUpToDateByHash: isBenchBuildUpToDate,
        writeStateFile: () => {
          throw new Error('should not write state on skip')
        }
      }).run()
    } finally {
      process.argv = originalArgv
      stdout.mockRestore()
    }
    expect(calls).toHaveLength(0)
    expect(chunks.join('')).toBe(`${path.join(repoRoot, 'dist', 'mac-arm64', 'Orca.app')}\n`)
  })

  it('rebuilds when --skip-unchanged but stored hash differs', async () => {
    const { calls, runner } = recordingRunner()
    const originalArgv = process.argv
    process.argv = ['node', 'build-bench-app.mjs', '--skip-unchanged']
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await createBenchBuild({
        runner,
        env: {},
        rendererAssetsDir: assetsDir,
        readStateFile: () => ({ hash: 'stale', appPath: 'ignored' }),
        computeInputsHash: () => 'fresh',
        writeStateFile: () => {}
      }).run()
    } finally {
      process.argv = originalArgv
      vi.mocked(process.stdout.write).mockRestore()
    }
    expect(calls.some((c) => c.args[0]?.endsWith('run-electron-vite-build.mjs'))).toBe(true)
  })

  it('rebuilds when --skip-unchanged but packaged app dir is missing', async () => {
    const { calls, runner } = recordingRunner()
    const originalArgv = process.argv
    process.argv = ['node', 'build-bench-app.mjs', '--skip-unchanged']
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await createBenchBuild({
        runner,
        env: {},
        rendererAssetsDir: assetsDir,
        readStateFile: () => ({ hash: 'same', appPath: 'ignored' }),
        computeInputsHash: () => 'same',
        isUpToDateByHash: (input, deps) =>
          isBenchBuildUpToDate(input, { existsSync: () => false, ...deps }),
        writeStateFile: () => {}
      }).run()
    } finally {
      process.argv = originalArgv
      vi.mocked(process.stdout.write).mockRestore()
    }
    expect(calls.some((c) => c.args[0]?.endsWith('run-electron-vite-build.mjs'))).toBe(true)
  })
})
