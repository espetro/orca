import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

// vi.mock ratchet gate: prevents growth of vi.mock calls and guides toward port/adapter injection.

const BASELINE_PATH = 'config/vi-mock-baseline.json'

type BaselineData = {
  maxTotalMocks: number
  topModules: Record<string, number>
}

export function scanViMocks(root = process.cwd()): {
  total: number
  byModule: Record<string, number>
} {
  const output = execFileSync(
    'rg',
    ['--no-filename', '-o', 'vi\\.mock\\([\'"][^\'"]+[\'"]', 'src/', 'tests/'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    }
  )

  const byModule: Record<string, number> = {}
  let total = 0

  for (const line of output.split('\n')) {
    if (!line.trim()) {
      continue
    }
    const match = line.match(/vi\.mock\(['"]([^'"]+)['"]/)
    if (match) {
      total += 1
      const mod = match[1]
      byModule[mod] = (byModule[mod] ?? 0) + 1
    }
  }

  return { total, byModule }
}

export function main(root = process.cwd()): number {
  const baselineFile = path.join(root, BASELINE_PATH)
  const current = scanViMocks(root)

  if (process.argv[2] === '--init' || !fs.existsSync(baselineFile)) {
    const data: BaselineData = {
      maxTotalMocks: current.total,
      topModules: Object.fromEntries(
        Object.entries(current.byModule)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 30)
      )
    }
    fs.writeFileSync(baselineFile, `${JSON.stringify(data, null, 2)}\n`)
    console.log(`Initialized ${BASELINE_PATH}: maxTotalMocks = ${current.total}`)
    return 0
  }

  const baseline: BaselineData = JSON.parse(fs.readFileSync(baselineFile, 'utf8'))

  if (current.total > baseline.maxTotalMocks) {
    console.error(
      `vi.mock ratchet failed: ${current.total} vi.mock calls found (exceeds baseline cap of ${baseline.maxTotalMocks}).`
    )
    console.error(`Instead of adding vi.mock, use dependency injection / ports & adapters.`)
    return 1
  }

  if (process.argv[2] === '--prune') {
    if (current.total < baseline.maxTotalMocks) {
      baseline.maxTotalMocks = current.total
      fs.writeFileSync(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`)
      console.log(`Pruned vi.mock baseline cap to ${current.total}.`)
    }
    return 0
  }

  console.log(`vi.mock ratchet passed: ${current.total}/${baseline.maxTotalMocks} mocks.`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main())
}
