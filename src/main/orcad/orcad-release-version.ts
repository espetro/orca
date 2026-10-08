import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Release version for a packaged orcad. Managed deploys export ORCA_VERSION in the
 * launch command; a bare `node orcad.js` has no launcher, so the assemble script
 * drops an `orcad-release.json` next to orcad.js and we read that instead. A dev
 * checkout has neither and keeps the '0.0.0-orcad' sentinel.
 */
function readBundledReleaseVersion(): string | null {
  try {
    const entry = process.argv[1]
    if (!entry) {
      return null
    }
    const manifest = JSON.parse(readFileSync(join(dirname(entry), 'orcad-release.json'), 'utf8'))
    return typeof manifest?.version === 'string' && manifest.version.length > 0
      ? manifest.version
      : null
  } catch {
    return null
  }
}

export function resolveOrcadVersion(): string {
  return process.env.ORCA_VERSION ?? readBundledReleaseVersion() ?? '0.0.0-orcad'
}
