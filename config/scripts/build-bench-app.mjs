#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dirname, '../..')

// mise-managed pnpm lacks npm_execpath, which pnpm-run children need; the
// inlined spawn workaround restores it for native script invocations.
const MISE_PNPM_EXECPATH = '/Users/josocjoq/.local/share/mise/installs/pnpm/11.5.0/dist/pnpm.mjs'

// artifact = first entry is the liveness probe; remaining entries must also exist
const NATIVE_MODULES = [
  {
    script: 'build:computer-macos',
    sourceDir: path.join(repoRoot, 'native', 'computer-use-macos'),
    artifacts: [
      path.join(
        repoRoot,
        'native',
        'computer-use-macos',
        '.build',
        'release',
        'Orca Computer Use.app',
        'Contents',
        'MacOS',
        'orca-computer-use-macos'
      )
    ]
  },
  {
    script: 'build:keyboard-layout-macos',
    sourceDir: path.join(repoRoot, 'native', 'keyboard-layout-macos'),
    artifacts: [
      path.join(
        repoRoot,
        'native',
        'keyboard-layout-macos',
        '.build',
        'release',
        'orca-keyboard-layout'
      )
    ]
  },
  {
    script: 'build:notification-status-macos',
    sourceDir: path.join(repoRoot, 'native', 'notification-status-macos'),
    artifacts: [
      path.join(
        repoRoot,
        'native',
        'notification-status-macos',
        '.build',
        'release',
        'orca-notification-status'
      )
    ]
  }
]

export function parseArgs(argv) {
  return {
    rendererOnly: argv.includes('--renderer-only'),
    skipUnchanged: argv.includes('--skip-unchanged')
  }
}

const BENCH_INPUT_ROOTS = ['src', 'config']

export function getBenchHashFilePath(repoRootOverride = repoRoot) {
  return path.join(repoRootOverride, 'dist', 'mac-arm64', '.bench-build-hash.json')
}

// content hash of relative path + bytes, so a revert re-triggers the build
export function computeBenchInputsHash(roots, deps = {}) {
  const readdir = deps.readdirSync ?? readdirSync
  const readFile = deps.readFileSync ?? readFileSync
  const baseDir = deps.repoRoot ?? repoRoot
  const hash = (deps.createHash ?? createHash)('sha256')
  for (const root of roots.sort()) {
    const files = listSourceFiles(root, readdir)
      .map((file) => path.relative(baseDir, file))
      .sort()
    for (const relPath of files) {
      hash.update(relPath)
      hash.update(readFile(path.join(baseDir, relPath)))
    }
  }
  return hash.digest('hex')
}

export function isBenchBuildUpToDate({ storedHash, computedHash, packagedAppDir }, deps = {}) {
  const exists = deps.existsSync ?? existsSync
  return storedHash !== undefined && storedHash === computedHash && exists(packagedAppDir)
}

function readStoredBenchHash(hashFilePath, readFile = readFileSync) {
  try {
    return JSON.parse(readFile(hashFilePath, 'utf8'))
  } catch {
    return undefined
  }
}

function listSourceFiles(dir, readdir = readdirSync) {
  const files = []
  const visit = (current) => {
    for (const entry of readdir(current, { withFileTypes: true })) {
      if (entry.name === '.build') {
        continue
      }
      const entryPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        visit(entryPath)
      } else {
        files.push(entryPath)
      }
    }
  }
  visit(dir)
  return files
}

export function isNativeModuleUpToDate(module, deps = {}) {
  const stat = deps.statSync ?? statSync
  const exists = deps.existsSync ?? existsSync
  const readdir = deps.readdirSync ?? readdirSync
  for (const artifact of module.artifacts) {
    if (!exists(artifact)) {
      return false
    }
  }
  let newestSourceMtime = 0
  for (const file of listSourceFiles(module.sourceDir, readdir)) {
    newestSourceMtime = Math.max(newestSourceMtime, stat(file).mtimeMs)
  }
  const oldestArtifactMtime = Math.min(
    ...module.artifacts.map((artifact) => stat(artifact).mtimeMs)
  )
  return oldestArtifactMtime > newestSourceMtime
}

export function verifyStoreExposure(storeMatchCount) {
  return storeMatchCount >= 1
}

function log(message) {
  process.stderr.write(`[build:bench-app] ${message}\n`)
}

function runPnpmScript(runner, script) {
  const result = runner('node', [
    '-e',
    `const {spawnSync}=require('child_process');const env={...process.env,npm_execpath:'${MISE_PNPM_EXECPATH}'};for(const s of ['${script}']){const r=spawnSync('pnpm',['run',s],{env,stdio:'inherit'});if(r.status!==0)process.exit(r.status??1)}`
  ])
  if (result.status !== 0) {
    throw new Error(`native build failed: ${script} (exit ${result.status})`)
  }
}

export function createBenchBuild({
  runner = spawnSync,
  env = process.env,
  isUpToDate = isNativeModuleUpToDate,
  rendererAssetsDir = path.join(repoRoot, 'out', 'renderer', 'assets'),
  computeInputsHash = computeBenchInputsHash,
  isUpToDateByHash = isBenchBuildUpToDate,
  writeStateFile = writeFileSync,
  readStateFile = readStoredBenchHash,
  hashFilePath = getBenchHashFilePath()
} = {}) {
  const packagedAppPath = path.join(repoRoot, 'dist', 'mac-arm64', 'Orca.app')

  async function run() {
    const args = parseArgs(process.argv.slice(2))
    if (args.skipUnchanged) {
      const state = readStateFile(hashFilePath)
      const computedHash = computeInputsHash(
        BENCH_INPUT_ROOTS.map((dir) => path.join(repoRoot, dir))
      )
      const packagedAppDir = path.dirname(packagedAppPath)
      if (isUpToDateByHash({ storedHash: state?.hash, computedHash, packagedAppDir })) {
        log(`skipping build, inputs unchanged (hash ${computedHash.slice(0, 12)})`)
        process.stdout.write(`${packagedAppPath}\n`)
        return
      }
    }
    if (!args.rendererOnly) {
      log('step 1/5: native module builds')
      for (const module of NATIVE_MODULES) {
        if (isUpToDate(module)) {
          log(`  skip ${module.script} (artifacts newer than sources)`)
          continue
        }
        log(`  building ${module.script}`)
        runPnpmScript(runner, module.script)
      }
    } else {
      log('step 1/5: skipped native builds (--renderer-only)')
    }

    log('step 2/5: relay + cli builds')
    const relayResult = runner(
      process.execPath,
      [
        '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
        path.join(repoRoot, 'config', 'scripts', 'build-relay.mjs')
      ],
      { stdio: 'inherit', cwd: repoRoot }
    )
    if (relayResult.status !== 0) {
      throw new Error(`relay build failed (exit ${relayResult.status})`)
    }
    const cliResult = runner('pnpm', ['run', 'build:cli'], {
      stdio: 'inherit',
      cwd: repoRoot
    })
    if (cliResult.status !== 0) {
      throw new Error(`cli build failed (exit ${cliResult.status})`)
    }

    log('step 3/5: electron-vite build (VITE_EXPOSE_STORE=true)')
    const viteResult = runner(
      process.execPath,
      [path.join(repoRoot, 'config', 'scripts', 'run-electron-vite-build.mjs')],
      {
        env: { ...env, VITE_EXPOSE_STORE: 'true' },
        stdio: 'inherit',
        cwd: repoRoot
      }
    )
    if (viteResult.status !== 0) {
      throw new Error(`electron-vite build failed (exit ${viteResult.status})`)
    }

    log('step 4/5: ensure electron runtime')
    const runtimeResult = runner('pnpm', ['run', 'ensure:electron-runtime'], {
      stdio: 'inherit',
      cwd: repoRoot
    })
    if (runtimeResult.status !== 0) {
      throw new Error(`ensure:electron-runtime failed (exit ${runtimeResult.status})`)
    }

    log('step 5/5: electron-builder --dir')
    const builderResult = runner(
      'pnpm',
      ['exec', 'electron-builder', '--config', 'config/electron-builder.config.cjs', '--dir'],
      {
        stdio: 'inherit',
        cwd: repoRoot
      }
    )
    if (builderResult.status !== 0) {
      throw new Error(`electron-builder failed (exit ${builderResult.status})`)
    }

    log('verify renderer store exposure')
    const assetsDir = rendererAssetsDir
    const storeAssets = existsSync(assetsDir)
      ? readdirSync(assetsDir).filter((name) => /^store-.*\.js$/.test(name))
      : []
    let matchCount = 0
    for (const name of storeAssets) {
      const grep = runner('grep', ['-c', '__store', path.join(assetsDir, name)], {
        encoding: 'utf8'
      })
      matchCount += Number.parseInt((grep.stdout ?? '').trim(), 10) || 0
    }
    if (!verifyStoreExposure(matchCount)) {
      throw new Error(
        'LOUD FAILURE: renderer bundle has no __store matches in out/renderer/assets/store-*.js. ' +
          'VITE_EXPOSE_STORE was likely missing at build time. Re-run without --renderer-only after confirming the env var.'
      )
    }
    log(`store exposure verified (${matchCount} __store matches)`)

    writeStateFile(
      hashFilePath,
      JSON.stringify(
        {
          hash: computeInputsHash(BENCH_INPUT_ROOTS.map((dir) => path.join(repoRoot, dir))),
          appPath: packagedAppPath
        },
        null,
        2
      )
    )

    process.stdout.write(`${packagedAppPath}\n`)
  }

  return { run, packagedAppPath }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  createBenchBuild()
    .run()
    .catch((error) => {
      process.stderr.write(`[build:bench-app] ERROR: ${error.message}\n`)
      process.exit(1)
    })
}
