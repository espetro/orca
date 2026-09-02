import fs from 'node:fs'
import path from 'node:path'

// Why: tests outside every vitest project's include never run — not even in CI.
// This guard lists any test file on disk that no project would collect.

const ROOT = process.cwd()
const PROJECT_INCLUDES = [
  [
    'fast',
    [
      'src/shared/**/*.test.{ts,tsx}',
      'src/relay/**/*.test.{ts,tsx}',
      'src/cli/**/*.test.{ts,tsx}',
      'config/scripts/**/*.test.{ts,mjs}',
      'tests/tools/**/*.test.mjs'
    ]
  ],
  ['main', ['src/main/**/*.test.{ts,tsx}']],
  ['renderer', ['src/renderer/**/*.test.{ts,tsx}', 'src/preload/**/*.test.{ts,tsx}']],
  ['e2e-unit', ['tests/e2e/**/*.unit.test.ts']]
]
const TEST_DIRS = ['src', 'config', 'tests']
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'out', 'build', '.git', '__fixtures__'])

function globToRegExp(glob) {
  const sentinel = String.fromCharCode(0)
  const escaped = glob.replace(/[.+^$()|[\]\\]/g, '\\$&')
  const withBraces = escaped.replace(
    /\{([^}]+)\}/g,
    (_, alternatives) => `(?:${alternatives.split(',').join('|')})`
  )
  // Why: in glob semantics a/**/b also matches direct children (a/b).
  const withSegmentStar = withBraces
    .replace(/\/\*\*\//g, sentinel)
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .split(sentinel)
    .join('(?:/[^/]+)*/')
  return new RegExp(`^${withSegmentStar}$`)
}

const matchers = PROJECT_INCLUDES.map(([name, globs]) => [name, globs.map(globToRegExp)])

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) {
      continue
    }
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walk(full)
    } else if (entry.name.endsWith('.unit.test.ts') || isVitestCollectedName(entry.name)) {
      yield full
    }
  }
}

function isVitestCollectedName(name) {
  return /\.(?:test|mjs)\.(?:ts|tsx|js)$/.test(name)
}

const orphans = []
for (const dir of TEST_DIRS) {
  if (!fs.existsSync(dir)) {
    continue
  }
  for (const file of walk(dir)) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/')
    if (!matchers.some(([, globs]) => globs.some((re) => re.test(rel)))) {
      orphans.push(rel)
    }
  }
}

if (orphans.length > 0) {
  console.error(
    [
      'Test files matched by no vitest project (they will never run):',
      ...orphans.map((file) => `  ${file}`),
      'Add an include to the right project in config/vitest.config.ts, or move the file.'
    ].join('\n')
  )
  process.exit(1)
}
console.log(`No orphan test files (${matchers.map(([name]) => name).join(', ')} cover all).`)
