#!/usr/bin/env node
// Assemble a self-contained orca-serve tree for a given platform from the
// build outputs in out/orcad and out/web, plus the minimal node_modules
// closure the headless runtime needs at boot.
//
// Usage: node config/scripts/assemble-orcad-release.mjs --platform <linux-x64|darwin-arm64>

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))

const platformIndex = process.argv.indexOf('--platform')
const platform = platformIndex !== -1 ? process.argv[platformIndex + 1] : undefined

const WATCHER_BACKEND = {
  'linux-x64': '@parcel/watcher-linux-x64-glibc',
  'darwin-arm64': '@parcel/watcher-darwin-arm64',
  'win-x64': '@parcel/watcher-win32-x64'
}

if (!platform || !WATCHER_BACKEND[platform]) {
  console.error(
    `Usage: node config/scripts/assemble-orcad-release.mjs --platform <${Object.keys(WATCHER_BACKEND).join('|')}>`
  )
  process.exit(1)
}

const require = createRequire(join(repoRoot, 'package.json'))

// Resolve a package to its real directory, dereferencing pnpm's symlinked
// node_modules entries so the copied tree is self-contained.
function packageRoot(name) {
  const pkgJsonPath = require.resolve(`${name}/package.json`)
  return dirname(pkgJsonPath)
}

function copyDir(src, dest) {
  cpSync(src, dest, { recursive: true, dereference: true, verbatimSymlinks: false })
}

const outDir = join(repoRoot, 'dist', `orca-serve-${platform}`)
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const orcadOut = join(repoRoot, 'out', 'orcad')
const webOut = join(repoRoot, 'out', 'web')
if (!existsSync(orcadOut)) {
  throw new Error(`missing build output: ${orcadOut}`)
}
if (!existsSync(webOut)) {
  throw new Error(`missing build output: ${webOut}`)
}

copyDir(orcadOut, join(outDir, 'orcad'))
copyDir(webOut, join(outDir, 'web'))

const packages = [
  'node-pty',
  '@parcel/watcher',
  'picomatch',
  'is-glob',
  'is-extglob',
  'detect-libc',
  'node-addon-api',
  WATCHER_BACKEND[platform]
]

const nodeModulesDir = join(outDir, 'node_modules')
mkdirSync(nodeModulesDir, { recursive: true })
for (const name of packages) {
  const src = packageRoot(name)
  const dest = join(nodeModulesDir, name)
  mkdirSync(dirname(dest), { recursive: true })
  copyDir(src, dest)
}

function printTree(dir, prefix = '') {
  const entries = readdirSync(dir).sort()
  entries.forEach((entry, i) => {
    const full = join(dir, entry)
    const last = i === entries.length - 1
    const isDir = statSync(full).isDirectory()
    console.log(`${prefix}${last ? '└── ' : '├── '}${entry}${isDir ? '/' : ''}`)
    if (isDir && prefix.length < 8) {
      printTree(full, `${prefix}${last ? '    ' : '│   '}`)
    }
  })
}

console.log(`\nassembled dist/orca-serve-${platform}:`)
printTree(outDir)
