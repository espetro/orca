import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { selectStaleDevBundleDirs } from './dev-electron-bundle-cache.mts'

const DEV_BUNDLE_MARKER_FILE = 'orca-dev-electron-app.json'

function getMtimeMs(filePath: string): number {
  try {
    return statSync(filePath).mtimeMs
  } catch {
    return 0
  }
}

function getDevBundleProcessTable(): string | null {
  // Not pgrep: macOS pgrep has no -a (a Linux procps extension) and silently prints bare PIDs,
  // which reads as "nothing is running" and deletes a live bundle. -ww keeps the command column
  // from being truncated. The raw text is searched directly; see dev-electron-bundle-cache.mts
  // for why it is deliberately not parsed into paths.
  try {
    return execFileSync('/bin/ps', ['-Awwo', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000
    })
  } catch {
    // Treating a failure as "nothing live" would risk deleting a running bundle, so skip pruning.
    return null
  }
}

/** Deletes sibling dev bundle directories no live instance depends on. */
export function pruneStaleDevBundles(distDir: string): void {
  const root = path.dirname(distDir)
  let bundles
  try {
    bundles = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const dir = path.join(root, entry.name)
        return {
          dir,
          hasMarker: existsSync(path.join(dir, DEV_BUNDLE_MARKER_FILE)),
          mtimeMs: getMtimeMs(dir)
        }
      })
  } catch {
    return
  }
  if (bundles.length <= 1) {
    return
  }
  const processTable = getDevBundleProcessTable()
  if (processTable === null) {
    return
  }
  const stale = selectStaleDevBundleDirs({
    bundles,
    currentDir: distDir,
    processTable,
    nowMs: Date.now()
  })
  for (const dir of stale) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
}

export { DEV_BUNDLE_MARKER_FILE, getDevBundleProcessTable }
