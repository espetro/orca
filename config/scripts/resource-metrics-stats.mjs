// Numeric primitives shared by the dump comparison and the footprint-category
// comparison. Lower is better for every compared metric (rss/footprint/heap are
// memory, cpuPercent is load), so an A-side median below B-side counts as
// 'improved'.

// Canonical resource-process role order; every per-role rollup iterates this.
export const ROLES = ['main', 'renderer', 'gpu', 'utility', 'zygote', 'other']

// Linear-interpolation percentile (standard method, R-7).
export function percentile(sortedValues, q) {
  if (sortedValues.length === 0) {
    return null
  }
  const pos = (sortedValues.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) {
    return sortedValues[lo]
  }
  return sortedValues[lo] + (pos - lo) * (sortedValues[hi] - sortedValues[lo])
}

export function round6(value) {
  return value === null ? null : Math.round(value * 1e6) / 1e6
}

export function numericStats(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const q1 = percentile(sorted, 0.25)
  const q3 = percentile(sorted, 0.75)
  return {
    median: round6(percentile(sorted, 0.5)),
    q1: round6(q1),
    q3: round6(q3),
    iqr: round6(q3 - q1),
    p10: round6(percentile(sorted, 0.1)),
    p90: round6(percentile(sorted, 0.9)),
    min: round6(sorted[0]),
    max: round6(sorted.at(-1)),
    n: sorted.length
  }
}

export function median(values) {
  if (values.length === 0) {
    return null
  }
  const sorted = [...values].sort((a, b) => a - b)
  return percentile(sorted, 0.5)
}

export function iqrOverlaps(a, b) {
  return a.q1 <= b.q3 && b.q1 <= a.q3
}

export function compareMetric(a, b) {
  // Lower median wins; lower is better for memory and cpu alike.
  if (a.median < b.median) {
    return 'improved'
  }
  return 'regressed'
}
