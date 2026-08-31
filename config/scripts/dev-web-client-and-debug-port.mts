import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { createHash } from 'node:crypto'

function getMtimeMs(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}

function getDevWebClientIndexPath(repoRoot: string): string {
  return path.join(repoRoot, 'out', 'web', 'web-index.html')
}

function latestMtimeMs(targetPath: string): number {
  const stat = (() => {
    try {
      return statSync(targetPath)
    } catch {
      return null
    }
  })()
  if (!stat) {
    return 0
  }
  if (!stat.isDirectory()) {
    return stat.mtimeMs
  }
  let latest = stat.mtimeMs
  for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
      continue
    }
    latest = Math.max(latest, latestMtimeMs(path.join(targetPath, entry.name)))
  }
  return latest
}

function isDevWebClientFresh(repoRoot: string): boolean {
  const outputMtime = getMtimeMs(getDevWebClientIndexPath(repoRoot))
  if (outputMtime === 0) {
    return false
  }
  const sourceMtime = Math.max(
    latestMtimeMs(path.join(repoRoot, 'vite.web.config.ts')),
    latestMtimeMs(path.join(repoRoot, 'src', 'renderer')),
    latestMtimeMs(path.join(repoRoot, 'src', 'shared')),
    latestMtimeMs(path.join(repoRoot, 'src', 'preload', 'api-types.ts'))
  )
  return sourceMtime <= outputMtime
}

/** Builds the optional pairing web bundle when its inputs are newer than the output. */
export function prepareDevWebClient(
  repoRoot: string,
  viteCli: string,
  { isHelpOrVersion }: { isHelpOrVersion: boolean }
): void {
  if (process.env.ORCA_SKIP_DEV_WEB_PREPARE === '1' || isHelpOrVersion) {
    return
  }
  // Why: fresh worktrees should start Electron immediately; pairing already
  // falls back to non-browser URLs when the optional web bundle is unavailable.
  if (!existsSync(getDevWebClientIndexPath(repoRoot)) && process.env.ORCA_DEV_WEB_PREPARE !== '1') {
    console.error(
      '[orca-dev] Web client bundle missing; skipping pairing web build. Run `pnpm run build:web` or set ORCA_DEV_WEB_PREPARE=1 when you need browser pairing.'
    )
    return
  }
  if (isDevWebClientFresh(repoRoot)) {
    return
  }
  console.error('[orca-dev] Building web client for pairing...')
  execFileSync(
    process.execPath,
    [viteCli, 'build', '--config', path.join(repoRoot, 'vite.web.config.ts')],
    {
      cwd: repoRoot,
      stdio: 'inherit',
      env: process.env
    }
  )
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => {
      // Why: error fires before listen binds; close() may throw — swallow it
      // so the handle is released without leaking listeners across 64 probes.
      try {
        srv.close()
      } catch {}
      resolve(false)
    })
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '127.0.0.1')
  })
}

export async function pickDebugPort(repoRoot: string): Promise<number | null> {
  // Why: 32 bits of SHA1 (vs 16) reduces truncation bias; modulo 200 still
  // collides routinely across many worktrees, hence the probe sweep below.
  const seed = Number.parseInt(createHash('sha1').update(repoRoot).digest('hex').slice(0, 8), 16)
  const base = 9333 + (seed % 200) // deterministic base in 9333..9532; probe sweeps up to base+63
  for (let i = 0; i < 64; i++) {
    const port = base + i
    if (await isPortFree(port)) {
      return port
    }
  }
  return null
}

export function parseDebugPortEnv(raw: string): number | null {
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535 || String(parsed) !== raw.trim()) {
    return null
  }
  return parsed
}

/** Resolves the forwarded `--remote-debugging-port` flag; null when the user already passed one. */
export async function resolveRemoteDebuggingPort(
  repoRoot: string,
  forwardedRaw: readonly string[]
): Promise<string[]> {
  // Why: exact match (or `=` form) avoids false positives on hypothetical
  // `--remote-debugging-port-*` flags; the bare flag also covers the
  // space-separated form. `--remote-debugging-pipe` opts into pipe-based
  // debugging — don't fight the user's choice by injecting a port.
  const userPassedPort = forwardedRaw.some(
    (arg) =>
      arg === '--remote-debugging-port' ||
      arg.startsWith('--remote-debugging-port=') ||
      arg === '--remote-debugging-pipe'
  )
  // Why: --help/--version exit immediately; binding a probe socket and printing
  // a debug-port line would be noise.
  const isHelpOrVersion = forwardedRaw.some(
    (arg) => arg === '--help' || arg === '-h' || arg === '--version'
  )
  if (!isHelpOrVersion && process.env.ORCA_DEV_INSTANCE_LABEL) {
    console.error(`[orca-dev] Instance: ${process.env.ORCA_DEV_INSTANCE_LABEL}`)
  }
  if (userPassedPort || isHelpOrVersion) {
    return []
  }
  const envPortRaw = process.env.REMOTE_DEBUGGING_PORT
  let port: number | null = null
  if (envPortRaw) {
    port = parseDebugPortEnv(envPortRaw)
    if (port === null) {
      console.error(
        `[orca-dev] Ignoring invalid REMOTE_DEBUGGING_PORT=${JSON.stringify(envPortRaw)}; falling back to probe.`
      )
    }
  }
  if (port === null) {
    port = await pickDebugPort(repoRoot)
  }
  if (port !== null) {
    // Why: stderr keeps stdout clean for downstream parsing; log uses
    // 127.0.0.1 to match the interface we actually probed (localhost may
    // resolve to ::1 on IPv6-first hosts).
    console.error(`[orca-dev] Remote debugging on http://127.0.0.1:${port}`)
    return [`--remote-debugging-port=${port}`]
  }
  console.error(
    '[orca-dev] No free debug port found in sweep; starting without --remote-debugging-port.'
  )
  return []
}
