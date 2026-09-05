import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// The lint steps are independent read-only checks with no ordering
// dependencies, so they can run concurrently instead of in a `&&` chain.
// Fail-fast is off: every step runs and reports, exit code aggregates.
const steps: { label: string; command: string[] }[] = [
  { label: 'oxlint', command: ['pnpm', 'exec', 'oxlint'] },
  {
    label: 'check:test-project-membership',
    command: ['node', 'config/scripts/check-test-project-membership.mjs']
  },
  {
    label: 'audit:code-quality:native',
    command: [
      'pnpm',
      'exec',
      'oxlint',
      '--config',
      'config/oxlint-code-quality-native-plugins.json',
      'src',
      'config',
      'tests',
      'mobile',
      '--deny-warnings'
    ]
  },
  {
    label: 'audit:code-quality:type-aware',
    command: [
      'pnpm',
      'exec',
      'oxlint',
      '--type-aware',
      '--config',
      'config/oxlint-code-quality-type-aware.json',
      'src',
      'config',
      'tests',
      '--deny-warnings'
    ]
  },
  {
    label: 'check:reliability-gates',
    command: ['node', 'config/scripts/check-reliability-gates.ts']
  },
  {
    label: 'check:max-lines-ratchet',
    command: ['node', 'config/scripts/check-max-lines-ratchet.ts']
  },
  {
    label: 'check:trivial-test-ratchet',
    command: ['node', 'config/scripts/check-trivial-test-ratchet.ts']
  },
  {
    label: 'check:ipc-channel-parity',
    command: ['node', 'config/scripts/check-ipc-channel-parity.mjs']
  },
  {
    label: 'check:runtime-electron-ratchet',
    command: ['node', 'config/scripts/check-runtime-electron-ratchet.ts']
  },
  {
    label: 'verify:bundled-skill-guides',
    command: ['node', 'config/scripts/generate-bundled-skill-guides.ts', '--check']
  },
  {
    label: 'verify:skill-bundle-manifest',
    command: ['node', 'config/scripts/generate-skill-bundle-manifest.ts']
  },
  {
    label: 'verify:localization-catalog',
    command: ['node', 'config/scripts/verify-localization-catalog.ts']
  },
  {
    label: 'verify:localization-extraction',
    command: ['node', 'config/scripts/verify-localization-extraction.ts']
  },
  {
    label: 'verify:localization-coverage',
    command: ['node', 'config/scripts/audit-localization-coverage.mjs', '--check']
  }
]

if (process.argv.includes('--list')) {
  for (const step of steps) {
    console.log(step.label)
  }
  process.exit(0)
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

// Why cap concurrency: the two oxlint steps are memory-heavy; on an 8 GB
// machine running all 14 at once swaps. Override with LINT_CONCURRENCY.
const concurrency = Math.max(1, Math.min(steps.length, Number(process.env.LINT_CONCURRENCY) || 4))

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

type StepResult = {
  label: string
  code: number | null
  signal: string | null
  durationMs: number
  output: string
}

function runStep(step: { label: string; command: string[] }): Promise<StepResult> {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    console.log(`${DIM}▶ ${step.label}${RESET}`)
    const child = spawn(step.command[0], step.command.slice(1), { cwd: repoRoot })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
    })
    child.on('error', (error) => {
      output += String(error)
      resolve({
        label: step.label,
        code: 1,
        signal: null,
        durationMs: Date.now() - startedAt,
        output
      })
    })
    child.on('exit', (code, signal) => {
      resolve({ label: step.label, code, signal, durationMs: Date.now() - startedAt, output })
    })
  })
}

const results: StepResult[] = []
const queue = [...steps]
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    for (let step = queue.shift(); step; step = queue.shift()) {
      const result = await runStep(step)
      results.push(result)
      const status = result.code === 0 ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`
      console.log(
        `${status} ${step.label} ${DIM}(${(result.durationMs / 1000).toFixed(1)}s)${RESET}`
      )
    }
  })
)

results.sort((a, b) => b.durationMs - a.durationMs)
console.log(`\n${DIM}── lint summary (concurrency=${concurrency}) ──${RESET}`)
for (const result of results) {
  const status = result.code === 0 ? `${GREEN}pass${RESET}` : `${RED}FAIL${RESET}`
  console.log(`${status}  ${(result.durationMs / 1000).toFixed(1).padStart(6)}s  ${result.label}`)
}
const failed = results.filter((r) => r.code !== 0)
if (failed.length > 0) {
  console.error(`\n${failed.length} lint step(s) failed:`)
  for (const result of failed) {
    console.error(`  ${result.label}`)
  }
  process.exit(1)
}
