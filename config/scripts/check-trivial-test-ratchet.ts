import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

// Ratchet check for trivial single-assertion test files.
// Fails on newly added test files that contain <= 1 it()/test() block and no side-effecting imports.

const BASELINE_PATH = 'config/trivial-tests-baseline.txt'
const IT_PATTERN = /\b(?:it|test)\s*\(/g
const SIDE_EFFECT_PATTERN =
  /\b(?:vi\.mock|mkdtemp|tmpdir|child_process|spawn|execFile|sqlite|electron|localStorage|indexedDB)\b/

export function countTestBlocks(source: string): number {
  return (source.match(IT_PATTERN) || []).length
}

export function hasSideEffects(source: string): boolean {
  return SIDE_EFFECT_PATTERN.test(source)
}

export function parseBaseline(text: string): Set<string> {
  return new Set(
    text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
  )
}

export function findTrivialTests(root = process.cwd()): string[] {
  const tracked = execFileSync('git', ['ls-files', 'src/**/*.test.ts', 'src/**/*.test.tsx'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
    .split('\n')
    .filter(Boolean)

  const trivial: string[] = []
  for (const rel of tracked) {
    let source: string
    try {
      source = fs.readFileSync(path.join(root, rel), 'utf8')
    } catch {
      continue
    }
    const count = countTestBlocks(source)
    if (count <= 1 && !hasSideEffects(source)) {
      trivial.push(rel)
    }
  }
  return trivial.sort()
}

export function main(root = process.cwd()): number {
  const baselineFile = path.join(root, BASELINE_PATH)
  if (!fs.existsSync(baselineFile)) {
    console.error(`Missing baseline file: ${BASELINE_PATH}. Generate with --init`)
    return 1
  }
  const baseline = parseBaseline(fs.readFileSync(baselineFile, 'utf8'))
  const current = findTrivialTests(root)

  const added = current.filter((file) => !baseline.has(file))
  const pruned = [...baseline].filter((file) => !current.includes(file))

  if (added.length > 0) {
    console.error(
      `Trivial test file ratchet failed: ${added.length} new trivial test file(s) found. Prefer table-driven it.each or property tests:`
    )
    for (const f of added) {
      console.error(`  - ${f}`)
    }
    return 1
  }

  if (pruned.length > 0) {
    console.log(
      `Notice: ${pruned.length} trivial test files have been eliminated. Run with --prune to update baseline.`
    )
  }

  console.log(`Trivial test ratchet passed: ${current.length} baseline trivial tests permitted.`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd()
  const arg = process.argv[2]
  const baselineFile = path.join(root, BASELINE_PATH)

  if (arg === '--init') {
    const current = findTrivialTests(root)
    const header = [
      '# Baseline of files with <= 1 it() block and no side-effects.',
      '# This list must only shrink over time as tests are collapsed into table-driven suites.',
      ''
    ].join('\n')
    fs.writeFileSync(baselineFile, `${header}${current.join('\n')}\n`)
    console.log(`Wrote ${baselineFile} with ${current.length} entries.`)
    process.exit(0)
  }

  if (arg === '--prune') {
    const current = new Set(findTrivialTests(root))
    const baseline = parseBaseline(fs.readFileSync(baselineFile, 'utf8'))
    const kept = [...baseline].filter((f) => current.has(f)).sort()
    const header = [
      '# Baseline of files with <= 1 it() block and no side-effects.',
      '# This list must only shrink over time as tests are collapsed into table-driven suites.',
      ''
    ].join('\n')
    fs.writeFileSync(baselineFile, `${header}${kept.join('\n')}\n`)
    console.log(
      `Pruned ${baselineFile} to ${kept.length} entries (removed ${baseline.size - kept.length}).`
    )
    process.exit(0)
  }

  process.exit(main(root))
}
