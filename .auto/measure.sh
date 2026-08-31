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
CAND="$(node config/scripts/build-bench-app.mjs "${BUILD_ARGS[@]}" | tail -n 1)"
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
const mainA = stat(bySide.A, (t) => t.mainProcess?.rssBytes)
const mainB = stat(bySide.B, (t) => t.mainProcess?.rssBytes)
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
EOF
}

# Protocol (empirical, from decay probes on this machine): the app needs ~2.5min
# to reach steady-state RSS after the fixture (progressive GC), so a long settle
# is mandatory; short-settle screens measured a transient, not idle RSS. One
# honest 3-run A/B replaces the planned screen+escalate ladder; --runs 1 is not
# possible (harness MIN_AB_RUNS=3) and pooled per-side medians already denoise.
SETTLE_S="${MEASURE_SETTLE_S:-120}"
WINDOW_S="${MEASURE_WINDOW_S:-60}"
# Warmup discard run: the first spawn after a sweep measures a cold-cache boot
# transient (median ~2x the steady cluster, see log.jsonl run 1). Harness
# MIN_AB_RUNS=3 so the warmup is one extra cheap A pair; its artifacts go to a
# separate dir and are never analyzed. Their only job is to dirty the page
# cache and do the first-run warmup so measured runs 1-3 land on steady state.
node config/scripts/run-release-memory-benchmark.mjs --ab "$CAND" "$BASE" \
  --runs 1 --settle-s 30 --window-s 15 --out "$TMP/warmup" >/dev/null 2>&1 || true
node config/scripts/run-release-memory-benchmark.mjs --ab "$CAND" "$BASE" \
  --runs 3 --settle-s "$SETTLE_S" --window-s "$WINDOW_S" --no-editor --out "$TMP/s1"
eval "$(analyze "$TMP/s1")"

mb() { awk -v b="$1" 'BEGIN{printf "%.2f", b/1048576}'; }
echo "METRIC main_rss_delta_mb=$(mb "$MAIN")"
echo "METRIC combined_rss_delta_mb=$(mb "$COMB")"
echo "METRIC heap_used_delta_mb=$(mb "$HEAP")"
echo "METRIC main_cpu_delta_pct=$CPU"
echo "# settle=${SETTLE_S}s window=${WINDOW_S}s runs=3 (+1 warmup discard)" >&2
