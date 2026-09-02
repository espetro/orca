// Bench startup switches for memory-benchmark runs (ORCA_BENCH_ONLY / ORCA_BENCH_DISABLE).
// Analogue of Chromium's --enable-benchmarking: when any bench flag is present, the main
// entry always disables experiments/telemetry/updates, and --only skips subsystem init
// that is cheaply gateable.
//
// NOT gated (remains ungated even in bench mode): PTY/runtime/daemon subsystems, plugin
// kernel manifest discovery, IPC handler registration, and window lifecycle. Full lazy
// registration is out of scope for this iteration.

export const BENCH_ALWAYS_DISABLED = ['experiments', 'telemetry', 'updates'] as const

export const BENCH_ONLY_ENV = 'ORCA_BENCH_ONLY'
export const BENCH_DISABLE_ENV = 'ORCA_BENCH_DISABLE'

export type BenchStartupSwitches = {
  benchMode: boolean
  /** Subsystems requested via --only=<value> / ORCA_BENCH_ONLY (deduped, insertion order). */
  only: string[]
  /** Subsystems disabled via --disable-<name> / ORCA_BENCH_DISABLE (deduped, insertion order). */
  disabled: string[]
}

function splitEnvList(value: string | undefined): string[] {
  if (!value) {
    return []
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export function parseBenchStartupSwitches(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env
): BenchStartupSwitches {
  const only: string[] = []
  const disabled: string[] = []
  for (const arg of argv) {
    if (arg.startsWith('--only=')) {
      const value = arg.slice('--only='.length)
      if (value) {
        only.push(value)
      }
    } else if (arg.startsWith('--disable-')) {
      const value = arg.slice('--disable-'.length)
      if (value) {
        disabled.push(value)
      }
    }
  }
  only.push(...splitEnvList(env[BENCH_ONLY_ENV]))
  disabled.push(...splitEnvList(env[BENCH_DISABLE_ENV]))
  return {
    benchMode: only.length > 0 || disabled.length > 0,
    only: [...new Set(only)],
    disabled: [...new Set(disabled)]
  }
}

let cached: BenchStartupSwitches | null = null

/** Memoized parse for call sites that cannot thread the switches through (e.g. deferred updater setup). */
export function getBenchStartupSwitches(): BenchStartupSwitches {
  cached ??= parseBenchStartupSwitches()
  return cached
}
