// Best-effort sweep of Electron trees leaked by a previous crashed bench run.
// Loud on purpose: leftovers both consume memory and squat the shared CDP port.
import { execFileSync } from 'node:child_process'
import path from 'node:path'

export function reapLeftovers(executablePath) {
  if (process.platform === 'win32') {
    return
  }
  let pids = []
  try {
    const marker = path.basename(executablePath)
    // macOS pgrep -f ERE: "$" anchor is unreliable, "( |$)" is not.
    pids = execFileSync('pgrep', ['-f', `${marker}( |$)`], { encoding: 'utf8' })
      .split('\n')
      .map((value) => Number(value.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid)
  } catch {
    return // pgrep exit 1 = no matches
  }
  if (pids.length === 0) {
    return
  }
  console.warn(
    `[release-memory] reaping ${pids.length} leftover process(es) from a prior run: ${pids.join(',')}`
  )
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
}
