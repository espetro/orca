import { availableParallelism } from 'node:os'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Why: cap at cpus-1 (except win32 keeps a low fixed count) to reduce per-worker import cost without starving the machine.
const testWorkerOptions =
  process.platform === 'win32'
    ? { minWorkers: 4, maxWorkers: 4 }
    : (() => {
        const workers = Math.max(1, availableParallelism() - 1)
        return { minWorkers: workers, maxWorkers: workers }
      })()

export default defineConfig({
  define: {
    ORCA_FEATURE_WALL_ENABLED: 'true'
  },
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@': resolve('src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    // Why: Node 26's undefined Web Storage globals prevent Vitest from installing happy-dom's.
    // Why --expose-gc: retention tests need a deterministic collection point to measure what a queue really holds.
    execArgv: ['--no-experimental-webstorage', '--expose-gc'],
    // Why: happy-dom drops MutationObserver callbacks on GC; keep them alive like a browser does.
    setupFiles: [
      resolve('config/scripts/happy-dom-mutation-observer-retention.ts'),
      resolve('config/scripts/vitest-host-ports-setup.ts')
    ],
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'config/scripts/**/*.test.ts',
      'config/scripts/**/*.test.mjs',
      'tests/tools/**/*.test.mjs',
      'tests/e2e/**/*.unit.test.ts'
    ],
    // Why: the full suite runs heavy TS transforms plus real git/http fixtures;
    // the Vitest 5s defaults are too tight for the slowest integration cases.
    hookTimeout: 60_000,
    testTimeout: 30_000,
    // Why: Windows process and shell startup are slower under full-suite load;
    // macOS/Linux keep Vitest's default worker parallelism.
    ...testWorkerOptions
  }
})
