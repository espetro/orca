#!/usr/bin/env bash
# Memory autoresearch measure: candidate vs pinned baseline at idle, no-editor fixture.
# Primary metric: main_rss_delta_mb = candidate main-process rss median - baseline (lower/negative = better).
set -euo pipefail
cd "$(dirname "$0")/.." # repo root (worktree)

# Coordinator pre-builds the pre-loop baseline app here; override with ORCA_BENCH_BASE.
BASE="${ORCA_BENCH_BASE:-$HOME/Documents/prjcts/_own/orca-mem-worktrees/memloop/.auto/base-app/Orca.app}"
if [[ ! -d "$BASE" ]]; then
  echo "ERROR: baseline app not found at $BASE" >&2
  echo "The coordinator must build it there first (bench build at the lane's starting commit), or set ORCA_BENCH_BASE." >&2
  exit 2
fi

# Renderer-only build when renderer assets already exist (skip slow native step); else full build.
BUILD_ARGS=()
if [[ -d out/renderer/assets ]]; then
  BUILD_ARGS+=(--renderer-only)
fi
CAND="$(node config/scripts/build-bench-app.mjs "${BUILD_ARGS[@]}")"
if [[ ! -d "$CAND" ]]; then
  echo "ERROR: bench build did not yield an app path (got: '$CAND')" >&2
  exit 2
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

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
console.log(`MAIN=${Math.round((mainA - mainB))}`)
console.log(`COMB=${Math.round(comb)}`)
console.log(`HEAP=${Math.round((heapA - heapB))}`)
console.log(`MAIN_MB=${mb(mainA - mainB).toFixed(2)}`)
console.log(`COMB_MB=${mb(comb).toFixed(2)}`)
console.log(`HEAP_MB=${mb(heapA - heapB).toFixed(2)}`)
EOF
}

# Stage 1 screen. NOTE: harness requires --runs >= 3 in --ab mode (MIN_AB_RUNS),
# so the screen is 3 runs with a shortened window instead of the planned 1-run screen.
node config/scripts/run-release-memory-benchmark.mjs --ab "$CAND" "$BASE" \
  --runs 3 --settle-s 15 --window-s 45 --no-editor --out "$TMP/s1"
eval "$(analyze "$TMP/s1")"

ESC=0
if (( MAIN <= -3145728 )); then
  # Confirmed: longer settle + full 60s window, fresh runs.
  node config/scripts/run-release-memory-benchmark.mjs --ab "$CAND" "$BASE" \
    --runs 3 --settle-s 20 --window-s 60 --no-editor --out "$TMP/s3"
  eval "$(analyze "$TMP/s3")"
  ESC=1
fi

mb() { node -e "console.log((process.argv[1]/1048576).toFixed(2))" "$1"; }
echo "METRIC main_rss_delta_mb=$(mb "$MAIN")"
echo "METRIC combined_rss_delta_mb=$(mb "$COMB")"
echo "METRIC heap_used_delta_mb=$(mb "$HEAP")"
if (( ESC )); then echo "# escalated"; fi
