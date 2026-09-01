export type PsFootprintRow = { rssBytes: number; footprintBytes: number | null }

/**
 * Parses `ps -o pid=,rss=,phys_footprint= -p <pids>` stdout.
 * rss is KB, phys_footprint on macOS is bytes. Header/junk lines are skipped.
 */
export function parsePsFootprint(stdout: string): Map<number, PsFootprintRow> {
  const rows = new Map<number, PsFootprintRow>()
  for (const line of stdout.split('\n')) {
    const fields = line.trim().split(/\s+/)
    // ps drops unknown keywords, so a host without phys_footprint emits only
    // "pid rss". Accept the 2-field form: footprint is simply unavailable.
    if (fields.length !== 3 && fields.length !== 2) {
      continue
    }
    const pid = Number(fields[0])
    const rssKb = Number(fields[1])
    const footprintBytes = fields.length === 3 ? Number(fields[2]) : Number.NaN
    if (!Number.isFinite(pid) || !Number.isFinite(rssKb)) {
      continue
    }
    if (pid <= 0) {
      continue
    }
    rows.set(pid, {
      rssBytes: rssKb * 1024,
      footprintBytes: Number.isFinite(footprintBytes) ? footprintBytes : null
    })
  }
  return rows
}

/** Parses `pmset -g therm`; null on n/a, unsupported output, or missing line. */
export function parseDarwinThermal(stdout: string): { cpuSpeedLimitPercent: number | null } | null {
  const match = stdout.match(/CPU_Speed_Limit\s*=\s*(\S+)/)
  if (!match) {
    return null
  }
  if (/^n\/?a$/i.test(match[1])) {
    return { cpuSpeedLimitPercent: null }
  }
  const percent = Number(match[1])
  if (!Number.isFinite(percent)) {
    return { cpuSpeedLimitPercent: null }
  }
  return { cpuSpeedLimitPercent: percent }
}

function parseVmStatCounters(stdout: string, label: string): number | null {
  const match = stdout.match(new RegExp(`${label}:\\s*(\\d+)\\.`))
  return match ? Number(match[1]) : null
}

/** Deltas of "Page ins: N." / "Page outs: N." between two vm_stat outputs; null if unparseable. */
export function parseVmStatDeltas(
  prev: string,
  next: string
): { pageinsDelta: number; pageoutsDelta: number } | null {
  const prevIn = parseVmStatCounters(prev, 'Page ins')
  const prevOut = parseVmStatCounters(prev, 'Page outs')
  const nextIn = parseVmStatCounters(next, 'Page ins')
  const nextOut = parseVmStatCounters(next, 'Page outs')
  if (prevIn === null || prevOut === null || nextIn === null || nextOut === null) {
    return null
  }
  return { pageinsDelta: nextIn - prevIn, pageoutsDelta: nextOut - prevOut }
}
