import { availableParallelism } from 'node:os'
import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import type { ViteUserConfig } from 'vitest/config'

// Why: cap at cpus-1 (except win32 keeps a low fixed count) to reduce per-worker import cost without starving the machine.
const testWorkerOptions =
  process.platform === 'win32'
    ? { minWorkers: 4, maxWorkers: 4 }
    : (() => {
        const workers = Math.max(1, availableParallelism() - 1)
        return { minWorkers: workers, maxWorkers: workers }
      })()

// Shared options every project must carry: Vitest 4 projects do NOT inherit
// root-level test options like setupFiles/timeouts/execArgv.
const sharedTestOptions = {
  setupFiles: [resolve('config/scripts/vitest-host-ports-setup.ts')],
  // Why: the full suite runs heavy TS transforms plus real git/http fixtures;
  // the Vitest 5s defaults are too tight for the slowest integration cases.
  hookTimeout: 60_000,
  testTimeout: 30_000,
  // CI-only: one retry keeps a flaky test from failing a required shard; local
  // runs stay retry-free so flakiness surfaces for devs. Retried-but-passed
  // tests are printed by the default reporter and scraped into the job summary.
  retry: process.env.CI ? 1 : 0
} satisfies ViteUserConfig['test']

// Why: Node 26's undefined Web Storage globals prevent Vitest from installing happy-dom's.
// Why --expose-gc: retention tests need a deterministic collection point to measure what a queue really holds.
// Not passed to the threads pool: worker_threads cannot honor --expose-gc and the workers die at startup.
const forkedPoolExecArgv = { execArgv: ['--no-experimental-webstorage', '--expose-gc'] }

// Why: Vitest 4 projects build independent Vite configs and do not inherit root resolve.alias.
const sharedResolve = {
  alias: {
    '@renderer': resolve('src/renderer/src'),
    '@': resolve('src/renderer/src')
  }
}

export default defineConfig({
  define: {
    ORCA_FEATURE_WALL_ENABLED: 'true'
  },
  // Why: projects build independent Vite servers; keep the canonical alias table
  // in sharedResolve and spread it both here and into every project.
  resolve: sharedResolve,
  test: {
    // Why: deterministic discovery for deps.optimizer candidates — surfaces per-module
    // import self/transform time instead of guessing. 'on-warn' keeps output quiet
    // until something crosses the warn threshold.
    experimental: {
      importDurations: {
        print: 'on-warn',
        limit: 10,
        thresholds: { warn: 100, danger: 500 }
      }
    },
    ...sharedTestOptions,
    ...testWorkerOptions,
    projects: [
      {
        resolve: sharedResolve,
        test: {
          ...sharedTestOptions,
          name: 'fast',
          environment: 'node',
          // Why: forks, not threads — tests here call process.umask(), which
          // worker_threads cannot set, and pass per-process env to git/node children.
          pool: 'forks',
          isolate: true,
          include: [
            'src/shared/**/*.test.{ts,tsx}',
            'src/relay/**/*.test.{ts,tsx}',
            'src/cli/**/*.test.{ts,tsx}',
            'config/scripts/**/*.test.ts',
            'config/scripts/**/*.test.mjs',
            'tests/tools/**/*.test.mjs'
          ]
        }
      },
      {
        resolve: sharedResolve,
        test: {
          ...sharedTestOptions,
          ...forkedPoolExecArgv,
          name: 'main',
          environment: 'node',
          // Why: main-process tests touch real processes/fs state; keep fork isolation.
          pool: 'forks',
          isolate: true,
          include: ['src/main/**/*.test.{ts,tsx}']
        }
      },
      {
        resolve: sharedResolve,
        test: {
          ...sharedTestOptions,
          setupFiles: [
            ...sharedTestOptions.setupFiles,
            resolve('config/scripts/happy-dom-mutation-observer-retention.ts')
          ],
          ...forkedPoolExecArgv,
          name: 'renderer',
          // Per-file @vitest-environment happy-dom docblocks still apply within this node-default project.
          environment: 'node',
          include: ['src/renderer/**/*.test.{ts,tsx}', 'src/preload/**/*.test.{ts,tsx}'],
          // Why: transform cost dominates renderer tests; pre-bundling the heavy
          // deps once removes per-worker ESM-to-ESM transform passes.
          // Policy: only add a lib here when root-level `experimental.importDurations`
          // shows it repeatedly above the warn threshold across test files. One-off
          // slow imports don't qualify; xterm is in because ~70 test files import
          // @xterm/xterm or @xterm/headless and optimizer prebundling cut their
          // transform+import time by ~18% (measured A/B).
          deps: {
            optimizer: {
              web: {
                include: [
                  'react',
                  'react-dom',
                  'react-dom/client',
                  'react-dom/server',
                  'i18next',
                  'react-i18next',
                  'zustand',
                  'react-router',
                  '@xterm/xterm',
                  '@xterm/headless'
                ]
              }
            }
          }
        }
      },
      {
        resolve: sharedResolve,
        test: {
          ...sharedTestOptions,
          ...forkedPoolExecArgv,
          name: 'e2e-unit',
          environment: 'node',
          include: ['tests/e2e/**/*.unit.test.ts']
        }
      }
    ]
  }
})
