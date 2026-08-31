// Nonparametric statistics for the memory A/B analysis: exact Mann-Whitney U
// p-value and Cliff's delta over per-run medians. Plain node, no deps.
//
// Two-sided Mann-Whitney U exact p-value (tie-aware average ranks).
export function mannWhitneyU(xs, ys) {
  const all = [...xs, ...ys].map((v, i) => ({ v, i }))
  all.sort((a, b) => a.v - b.v)
  const ranks = Array.from({ length: all.length })
  let i = 0
  while (i < all.length) {
    let j = i
    while (j + 1 < all.length && all[j + 1].v === all[i].v) {
      j += 1
    }
    const avg = (i + j) / 2 + 1
    for (let k = i; k <= j; k += 1) {
      ranks[all[k].i] = avg
    }
    i = j + 1
  }
  const rX = ranks.slice(0, xs.length).reduce((a, b) => a + b, 0)
  const uX = rX - (xs.length * (xs.length + 1)) / 2
  const uY = xs.length * ys.length - uX
  const u = Math.min(uX, uY)
  // Exact enumeration over C(n+m, n) assignments of pooled ranks.
  const combined = [...xs.map(() => 0), ...ys.map(() => 1)]
  let count = 0
  let hits = 0
  const perm = (arr, start) => {
    if (start === arr.length) {
      const r = arr.reduce((acc, g, idx) => acc + (g === 0 ? ranks[idx] : 0), 0)
      const ux = r - (xs.length * (xs.length + 1)) / 2
      const uu = Math.min(ux, xs.length * ys.length - ux)
      count += 1
      if (uu <= u) {
        hits += 1
      }
      return
    }
    for (let k = start; k < arr.length; k += 1) {
      ;[arr[start], arr[k]] = [arr[k], arr[start]]
      perm(arr, start + 1)
      ;[arr[start], arr[k]] = [arr[k], arr[start]]
    }
  }
  perm(combined, 0)
  return hits / count
}

// Cliff's delta: dominance measure in [-1, 1] from pairwise comparisons.
export function cliffsDelta(xs, ys) {
  let gt = 0
  let lt = 0
  for (const x of xs) {
    for (const y of ys) {
      if (x > y) {
        gt += 1
      } else if (x < y) {
        lt += 1
      }
    }
  }
  const total = xs.length * ys.length
  return total === 0 ? 0 : (gt - lt) / total
}
