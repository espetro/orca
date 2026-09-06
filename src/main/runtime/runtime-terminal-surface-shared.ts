import type { RuntimeTerminalPresentation } from '../../shared/runtime-terminal-contracts'

export const MOBILE_TERMINAL_SURFACE_TIMEOUT_MS = 10_000
export const MAX_TRACKED_PTY_LIVENESS_VERDICTS = 256
export const REJECTED_SPLIT_PTY_STOP_TIMEOUT_MS = 2_000
export const EXPLICIT_TERMINAL_CLOSE_STOP_TIMEOUT_MS = 2_000
export const MOBILE_TERMINAL_READY_FALLBACK_MS = 1000

export function isClientDisconnectedError(error: unknown): boolean {
  return error instanceof Error && error.message === 'client_disconnected'
}

// Why: an absent `surfaceOwner` means "default", so surfacing callers must omit
// the key rather than send `true`.
export function ownerSurfacing(shouldSurface: boolean): { surfaceOwner?: false } {
  return shouldSurface ? {} : { surfaceOwner: false }
}

export function resolveTerminalPresentation(opts: {
  presentation?: RuntimeTerminalPresentation
  focus?: boolean
  activate?: boolean
}): RuntimeTerminalPresentation | undefined {
  if (opts.presentation) {
    return opts.presentation
  }
  if (opts.focus === true || opts.activate === true) {
    return 'focused'
  }
  return undefined
}

export function omitUndefinedProperties<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as Partial<T>
}
