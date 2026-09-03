export const DEFAULT_CDP_PORT = 9223
export const DEFAULT_SETTLE_SECONDS = 30
export const DEFAULT_WINDOW_SECONDS = 120
export const DEFAULT_DURATION_SECONDS = DEFAULT_WINDOW_SECONDS
export const SAMPLE_INTERVAL_MS = 2_000
export const DEFAULT_FIXTURE = 'standard'
export const DEFAULT_RUNS = 3
export const MIN_AB_RUNS = 3
export const RESOURCES_BRIDGE_TIMEOUT_MS = 30_000

export const FIXTURES = {
  standard: { terminalPanes: 4, editor: true, browserTab: true },
  'no-editor': { terminalPanes: 4, editor: false, browserTab: false },
  orcad: { terminalPanes: 4, editor: false, browserTab: false, orcad: true }
}

export function parseReleaseMemoryBenchmarkArgs(argv) {
  const options = {
    app: null,
    fixture: DEFAULT_FIXTURE,
    settleSeconds: DEFAULT_SETTLE_SECONDS,
    windowSeconds: DEFAULT_WINDOW_SECONDS,
    cdpPort: DEFAULT_CDP_PORT,
    out: null,
    ab: null,
    runs: DEFAULT_RUNS,
    recorder: true
  }
  let index = 0
  while (index < argv.length) {
    const arg = argv[index]
    index += 1
    const readValue = () => {
      const value = argv[index]
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`)
      }
      index += 1
      return value
    }
    if (arg === '--') {
      continue
    } else if (arg === '--app') {
      options.app = readValue()
    } else if (arg === '--fixture') {
      options.fixture = readValue()
    } else if (arg === '--no-editor') {
      options.fixture = 'no-editor'
    } else if (arg === '--orcad') {
      options.fixture = 'orcad'
    } else if (arg === '--settle-s') {
      options.settleSeconds = Number(readValue())
    } else if (arg === '--window-s' || arg === '--duration') {
      options.windowSeconds = Number(readValue())
    } else if (arg === '--ab') {
      options.ab = [readValue(), readValue()]
    } else if (arg === '--runs') {
      options.runs = Number(readValue())
    } else if (arg === '--recorder') {
      options.recorder = true
    } else if (arg === '--no-recorder') {
      options.recorder = false
    } else if (arg === '--cdp-port') {
      options.cdpPort = Number(readValue())
    } else if (arg === '--out') {
      options.out = readValue()
    } else if (arg === '--help' || arg === '-h') {
      printUsage()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (!Number.isFinite(options.settleSeconds) || options.settleSeconds < 0) {
    throw new Error(`Invalid --settle-s: ${options.settleSeconds}`)
  }
  if (!Number.isFinite(options.windowSeconds) || options.windowSeconds <= 0) {
    throw new Error(`Invalid --duration/--window-s: ${options.windowSeconds}`)
  }
  if (!Number.isInteger(options.runs) || options.runs < 1) {
    throw new Error(`Invalid --runs: ${options.runs}`)
  }
  if (options.ab && options.runs < MIN_AB_RUNS) {
    throw new Error(`--ab requires --runs >= ${MIN_AB_RUNS} (got ${options.runs})`)
  }
  if (!Number.isInteger(options.cdpPort) || options.cdpPort <= 0) {
    throw new Error(`Invalid --cdp-port: ${options.cdpPort}`)
  }
  if (!FIXTURES[options.fixture]) {
    throw new Error(
      `Unknown fixture: ${options.fixture} (available: ${Object.keys(FIXTURES).join(', ')})`
    )
  }
  if (!options.app && !options.ab) {
    throw new Error('--app <path-to-.app-or-unpacked-dir> is required (or use --ab <appA> <appB>)')
  }
  return options
}

function printUsage() {
  console.log(
    `Usage: node config/scripts/run-release-memory-benchmark.mjs --app <path> [options]

Options:
  --app <path>        Path to a packaged .app bundle or unpacked release dir (required unless --ab)
  --ab <appA> <appB>  A/B mode: interleave runs across the two apps (requires --runs >= ${MIN_AB_RUNS})
  --runs <n>          Runs per side (default: ${DEFAULT_RUNS})
  --fixture <name>    Fixture preset (default: ${DEFAULT_FIXTURE}; available: ${Object.keys(FIXTURES).join(', ')})
  --no-editor         Shorthand for --fixture no-editor (no editor/browser pane)
  --orcad             Shorthand for --fixture orcad (headless orcad Node runtime)
  --settle-s <secs>   Settle time after fixture before sampling (default: ${DEFAULT_SETTLE_SECONDS})
  --window-s <secs>   Idle sampling window in seconds (default: ${DEFAULT_WINDOW_SECONDS}; --duration alias)
  --recorder          In-app resource recorder in child env (default: on; --no-recorder disables)
  --cdp-port <port>   Remote debugging port (default: ${DEFAULT_CDP_PORT})
  --out <dir>         Artifact output directory (default: tests/tools/benchmarks/results); files run-<label>-<side>-<runIndex>.json
  -h, --help          Show this help`
  )
}
