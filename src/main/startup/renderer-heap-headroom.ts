import { app } from 'electron'
import { totalmem } from 'node:os'
import { deriveHostMemoryBudget } from './host-memory-budget'

const RENDERER_HEAP_ENV_VAR = 'ORCA_RENDERER_HEAP_MB'

type HeapOverride = number | 'disable' | undefined

function parseRendererHeapOverrideMb(value: string | undefined): HeapOverride {
  if (value === undefined) {
    return undefined
  }
  const normalized = value.trim().toLowerCase()
  if (normalized === '') {
    return undefined
  }
  // Why: give operators an explicit opt-out (and E2E a way to pin the default)
  // without editing the RAM tiers.
  if (normalized === 'default' || normalized === 'off' || normalized === 'none') {
    return 'disable'
  }
  const parsed = Number(normalized)
  // Why: ignore an unparseable value (typo) and fall through to the RAM tiers,
  // but treat an explicit non-positive number as an opt-out.
  if (!Number.isFinite(parsed)) {
    return undefined
  }
  if (parsed <= 0) {
    return 'disable'
  }
  // Why: a fractional value in (0,1) floors to 0, which would emit an invalid
  // --max-old-space-size=0. Treat a floored-to-0 override as an opt-out too.
  const flooredMb = Math.floor(parsed)
  return flooredMb <= 0 ? 'disable' : flooredMb
}

/**
 * Renderer V8 old-space ceiling (MB) to request via --max-old-space-size, or
 * null to keep Chromium's physical-memory default. Pure so the RAM tiers and
 * the env override are unit-testable without spawning Electron.
 */
export function computeRendererHeapCeilingMb(
  totalMemoryBytes: number,
  envOverride?: string
): number | null {
  const override = parseRendererHeapOverrideMb(envOverride)
  if (override === 'disable') {
    return null
  }
  if (typeof override === 'number') {
    return override
  }
  if (!Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) {
    return null
  }
  const budget = deriveHostMemoryBudget(totalMemoryBytes)
  return budget.rendererMaxOldSpaceMb
}

export function enableRendererHeapHeadroom(
  options: { totalMemoryBytes?: number; env?: NodeJS.ProcessEnv } = {}
): void {
  const totalMemoryBytes = options.totalMemoryBytes ?? totalmem()
  if (!Number.isFinite(totalMemoryBytes) || totalMemoryBytes <= 0) {
    return
  }
  const envOverride = (options.env ?? process.env)[RENDERER_HEAP_ENV_VAR]
  const ceilingMb = computeRendererHeapCeilingMb(totalMemoryBytes, envOverride)
  const budget = deriveHostMemoryBudget(totalMemoryBytes)

  const existing = app.commandLine.getSwitchValue('js-flags')
  const flagsToAdd: string[] = []

  if (budget.optimizeForSize && !existing.includes('--optimize-for-size')) {
    flagsToAdd.push('--optimize-for-size')
  }
  // Why: respect an explicit --max-old-space-size someone already set (e.g. via
  // ELECTRON_EXTRA_LAUNCH_ARGS) instead of stacking a second, ignored value.
  if (ceilingMb !== null && !existing.includes('--max-old-space-size')) {
    flagsToAdd.push(`--max-old-space-size=${ceilingMb}`)
  }
  if (budget.exposeGc && !existing.includes('--expose-gc')) {
    flagsToAdd.push('--expose-gc')
  }

  if (flagsToAdd.length === 0) {
    return
  }

  // Why: js-flags is process-wide and must be set before app 'ready' so it
  // reaches renderer/utility V8 isolates when Chromium spawns them.
  const flagString = existing ? `${existing} ${flagsToAdd.join(' ')}` : flagsToAdd.join(' ')
  app.commandLine.appendSwitch('js-flags', flagString)
}
