#!/usr/bin/env bash
# Memory autoresearch measure: candidate vs pinned baseline at idle, no-editor fixture.
# Primary metric: main_rss_delta_mb = candidate main-process rss median - baseline (lower/negative = better).
set -euo pipefail
cd "$(dirname "$0")/.." # repo root (worktree)

# Pinned pre-loop baseline app lives OUTSIDE the repo: electron-builder asar-packs
# the repo directory, so a baseline stored under .auto/ would be embedded in the
# candidate app and inflate its RSS. Override with ORCA_BENCH_BASE.
BASE="${ORCA_BENCH_BASE:-$HOME/Documents/prjcts/_own/orca-mem-worktrees/bench-bases/orca-mem-rss/Orca.app}"
if [[ ! -d "$BASE" ]]; then
  echo "ERROR: baseline app not found at $BASE" >&2
  echo "The coordinator must build it there first (bench build at the lane's starting commit), or set ORCA_BENCH_BASE." >&2
  exit 2
fi

# Renderer-only build when renderer assets already exist (skip slow native step); else full build.
# Exclude the pinned baseline from the asar; paths outside the repo are ignored anyway.
BUILD_ARGS=()
if [[ -d out/renderer/assets ]]; then
  BUILD_ARGS+=(--renderer-only)
fi
# Skip the whole build when src/ + config/ are unchanged since the last bench build.
BUILD_ARGS+=(--skip-unchanged)
CAND="$(node config/scripts/build-bench-app.mjs ${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"} | tail -n 1)"
if [[ ! -d "$CAND" ]]; then
  echo "ERROR: bench build did not yield an app path (got: '$CAND')" >&2
  exit 2
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
KEEP=0
if [[ "${MEASURE_KEEP_ARTIFACTS:-0}" == "1" ]]; then
  KEEP=1
  trap '' EXIT
  echo "artifacts kept in $TMP" >&2
fi

analyze() { # $1=outdir ; prints MAIN/COMB/HEAP byte deltas
  # The comparison artifact omits mainProcess.rssBytes (samples-only roles), so
  # pool all run artifacts per side and take medians here instead.
  node - "$1"/run-*.json <<'EOF'
// Primary: mainProcess.rssBytes median per side. combined: per-role sample
// workingSetKb medians summed (sample rssBytes is 0 on macOS; workingSetKb is
// the per-role proxy; mainProcess rss is NOT added to avoid double-counting).
const fs = require('node:fs')
// Rank-based two-sided Mann-Whitney U (exact enumeration, tie-aware) and
// Cliff's delta; inlined here because the analysis runs in plain node.
const mwU = (xs, ys) => {
  const nX = xs.length
  const nY = ys.length
  const all = [...xs.map((v) => ({ v, g: 0 })), ...ys.map((v) => ({ v, g: 1 }))]
  all.sort((a, b) => a.v - b.v)
  const ranks = new Array(all.length)
  let i = 0
  while (i < all.length) {
    let j = i
    while (j + 1 < all.length && all[j + 1].v === all[i].v) j += 1
    const avg = (i + j) / 2 + 1
    for (let k = i; k <= j; k += 1) ranks[k] = avg
    i = j + 1
  }
  const uOf = (groups) => {
    const r = groups.reduce((acc, g, idx) => acc + (g === 0 ? ranks[idx] : 0), 0)
    const ux = r - (nX * (nX + 1)) / 2
    return Math.min(ux, nX * nY - ux)
  }
  const observed = uOf(all.map((e) => e.g))
  let count = 0
  let hits = 0
  const perm = (arr, start) => {
    if (start === arr.length) {
      count += 1
      if (uOf(arr) <= observed) hits += 1
      return
    }
    for (let k = start; k < arr.length; k += 1) {
      ;[arr[start], arr[k]] = [arr[k], arr[start]]
      perm(arr, start + 1)
      ;[arr[start], arr[k]] = [arr[k], arr[start]]
    }
  }
  perm(all.map((e) => e.g), 0)
  return hits / count
}
const cliffs = (xs, ys) => {
  let gt = 0
  let lt = 0
  for (const x of xs)
    for (const y of ys) {
      if (x > y) gt += 1
      else if (x < y) lt += 1
    }
  const total = xs.length * ys.length
  return total === 0 ? 0 : (gt - lt) / total
}
const bySide = { A: [], B: [] }
for (const f of process.argv.slice(2)) {
  const m = /-(A|B)-\d+\.json$/.exec(f)
  if (!m) continue
  const art = JSON.parse(fs.readFileSync(f, 'utf8'))
  if (art.schema === 'orca.resource-bench-run') bySide[m[1]].push(art.dump)
}
const median = (xs) => {
  const s = xs.filter((v) => typeof v === 'number').sort((a, b) => a - b)
  const i = Math.floor(s.length / 2)
  return s.length === 0 ? 0 : s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2
}
const ROLES = ['main', 'renderer', 'gpu', 'utility', 'zygote', 'other']
const stat = (dumps, pick) => median(dumps.flatMap((d) => (d.ticks ?? []).map(pick).filter((v) => v != null)))
const mb = (bytes) => bytes / 1048576
// Per-run medians (3 per side) replace pooled tick medians: primary
// main_rss_delta_mb = median(A run medians) - median(B run medians).
const runMedians = (side, pick) =>
  bySide[side]
    .map((d) => median((d.ticks ?? []).map(pick).filter((v) => v != null)))
    .filter((v) => typeof v === 'number' && !Number.isNaN(v))
// Post-GC tail: last 5 ticks of each run (postGc tail wait is 5s at 2s ticks).
const runTailMedians = (side, pick) =>
  bySide[side]
    .map((d) => {
      const vals = (d.ticks ?? []).map(pick).filter((v) => v != null)
      return median(vals.slice(-5))
    })
    .filter((v) => typeof v === 'number' && !Number.isNaN(v))
const mainRunA = runMedians('A', (t) => t.mainProcess?.rssBytes)
const mainRunB = runMedians('B', (t) => t.mainProcess?.rssBytes)
const mainA = median(mainRunA)
const mainB = median(mainRunB)
const postA = median(runTailMedians('A', (t) => t.mainProcess?.rssBytes))
const postB = median(runTailMedians('B', (t) => t.mainProcess?.rssBytes))
// Sanity check vs historical identical-code artifacts (expected p=1, cliffs ~0):
//   MEASURE_KEEP_ARTIFACTS=1 node config/scripts/run-release-memory-benchmark.mjs \
//     --ab <appA> <appA> --runs 3 --settle-s 120 --window-s 60 --no-editor --out /tmp/same && \
//   node - /tmp/same/run-*.json   (feed this same inline script; p should be 1, cliffs_delta ~0)
let pval = 1
let cliffsVal = 0
if (mainRunA.length > 0 && mainRunB.length > 0) {
  pval = mwU(mainRunA, mainRunB)
  cliffsVal = cliffs(mainRunA, mainRunB)
}
const heapA = stat(bySide.A, (t) => t.mainProcess?.heapUsedBytes)
const heapB = stat(bySide.B, (t) => t.mainProcess?.heapUsedBytes)
let comb = 0
for (const r of ROLES) {
  comb += stat(bySide.A, (t) => t.samples?.find((s) => s.type === r)?.workingSetKb) * 1024
  comb -= stat(bySide.B, (t) => t.samples?.find((s) => s.type === r)?.workingSetKb) * 1024
}
// CPU secondary: MEAN of the main-role sample cpuPercent (not median, so a
// sustained load difference shows up instead of averaging away).
const mean = (xs) => { const s = xs.filter((v) => typeof v === 'number'); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0 }
const cpuA = mean(bySide.A.flatMap((d) => (d.ticks ?? []).map((t) => t.samples?.find((s) => s.type === 'main')?.cpuPercent)))
const cpuB = mean(bySide.B.flatMap((d) => (d.ticks ?? []).map((t) => t.samples?.find((s) => s.type === 'main')?.cpuPercent)))
console.log(`MAIN=${Math.round((mainA - mainB))}`)
console.log(`COMB=${Math.round(comb)}`)
console.log(`HEAP=${Math.round((heapA - heapB))}`)
console.log(`CPU=${(cpuA - cpuB).toFixed(3)}`)
console.log(`MAIN_MB=${mb(mainA - mainB).toFixed(2)}`)
console.log(`COMB_MB=${mb(comb).toFixed(2)}`)
console.log(`HEAP_MB=${mb(heapA - heapB).toFixed(2)}`)
console.log(`P=${pval.toFixed(4)}`)
console.log(`CLIFFS=${cliffsVal.toFixed(3)}`)
console.log(`POSTGC_MB=${mb(postA - postB).toFixed(2)}`)
EOF
}

# Protocol (empirical): the app reaches steady-state RSS after the fixture
# via the forced-GC protocol at window end, so a 90s settle suffices (was 120s
# waiting out the progressive-GC drain). Sanity A/B (same-app-vs-itself)
# confirmed the delta stays within the ±15MB noise floor.
SETTLE_S="${MEASURE_SETTLE_S:-90}"
WINDOW_S="${MEASURE_WINDOW_S:-60}"
# Warmup discard: the first spawn after a sweep measures a cold-cache boot
# transient (median ~2x the steady cluster, see log.jsonl run 1). One short
# run suffices to dirty the page cache; artifacts are never analyzed.
# (MIN_AB_RUNS=3 gates main A/B runs only; warmup uses --app single runs.)
node config/scripts/run-release-memory-benchmark.mjs --app "$CAND" \
  --runs 1 --settle-s 30 --window-s 15 --no-editor --out "$TMP/warmup" >/dev/null 2>&1 || true
node config/scripts/run-release-memory-benchmark.mjs --ab "$CAND" "$BASE" \
  --runs 3 --settle-s "$SETTLE_S" --window-s "$WINDOW_S" --no-editor --out "$TMP/s1"
eval "$(analyze "$TMP/s1")"

mb() { awk -v b="$1" 'BEGIN{printf "%.2f", b/1048576}'; }
echo "METRIC main_rss_delta_mb=$(mb "$MAIN")"
echo "METRIC combined_rss_delta_mb=$(mb "$COMB")"
echo "METRIC heap_used_delta_mb=$(mb "$HEAP")"
echo "METRIC main_cpu_delta_pct=$CPU"
echo "METRIC main_rss_postgc_delta_mb=$(mb "$POSTGC")"
echo "METRIC main_rss_pvalue=$P"
echo "METRIC main_rss_cliffs_delta=$CLIFFS"
echo "# settle=${SETTLE_S}s window=${WINDOW_S}s runs=3 (+1 warmup discard)" >&2
