// A/B comparison of the macOS `/usr/bin/footprint` per-VM-category dirty-byte
// table (V8 / PartitionAlloc / IOSurface / ...). darwin-only; every other host
// has no `footprintCategories`, so both entry points degrade to empty.
import {
  ROLES,
  compareMetric,
  iqrOverlaps,
  numericStats,
  round6
} from './resource-metrics-stats.mjs'

// Per-(role, category) dirty-byte stats. Empty map when no sample for `role`
// carries a category table.
export function perCategoryDirtyStats(ticks, role) {
  const byCategory = new Map()
  for (const tick of ticks) {
    for (const sample of tick.samples ?? []) {
      if (sample.type !== role || !Array.isArray(sample.footprintCategories)) {
        continue
      }
      for (const row of sample.footprintCategories) {
        const list = byCategory.get(row.category) ?? []
        list.push(row.dirtyBytes)
        byCategory.set(row.category, list)
      }
    }
  }
  const stats = new Map()
  for (const [category, values] of byCategory) {
    stats.set(category, numericStats(values))
  }
  return stats
}

// One verdict row per (role, category) pair present on either side. Same
// IQR-overlap -> inconclusive rule as the per-role metrics. [] when neither
// side carries a category table (non-macOS run).
export function compareFootprintCategories(a, b) {
  const rolesWithTable = new Set()
  for (const dump of [a, b]) {
    for (const tick of dump.ticks ?? []) {
      for (const sample of tick.samples ?? []) {
        if (Array.isArray(sample.footprintCategories) && sample.footprintCategories.length > 0) {
          rolesWithTable.add(sample.type)
        }
      }
    }
  }
  const rows = []
  for (const role of ROLES) {
    if (!rolesWithTable.has(role)) {
      continue
    }
    const statsA = perCategoryDirtyStats(a.ticks ?? [], role)
    const statsB = perCategoryDirtyStats(b.ticks ?? [], role)
    const categories = [...new Set([...statsA.keys(), ...statsB.keys()])].sort()
    for (const category of categories) {
      const ca = statsA.get(category) ?? numericStats([])
      const cb = statsB.get(category) ?? numericStats([])
      if (ca.n === 0 && cb.n === 0) {
        continue
      }
      const verdict =
        ca.n === 0 || cb.n === 0 || iqrOverlaps(ca, cb) ? 'inconclusive' : compareMetric(ca, cb)
      rows.push({
        role,
        category,
        a: ca,
        b: cb,
        verdict,
        deltaMedian: round6((ca.median ?? 0) - (cb.median ?? 0))
      })
    }
  }
  return rows
}
