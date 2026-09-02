# Objective

Reduce idle main-process phys_footprint of the candidate app vs the pinned baseline in the no-editor fixture, without regressing the other roles. Only confirmed reductions in `main_footprint_delta_mb` advance the branch; everything else is secondary.

# Metrics (read METRIC lines from measure.sh output)

- Primary: `main_footprint_delta_mb` — per-run median main-role phys_footprint (samples type=main footprintBytes), median of 3 runs per side, A minus B. Negative = better. Phys_footprint is pre-compression dirty+clean pages: the macOS-correct memory metric, ~5-9x tighter than RSS on this host (empirical half-spread 10.5MB vs 56-94MB).
- Secondary (must not regress): `main_footprint_pvalue` (exact Mann-Whitney over run medians), `combined_rss_delta_mb` (all roles workingSetKb), `heap_used_delta_mb`, `main_rss_postgc_delta_mb` (diagnostic only - forced V8 GC does NOT reclaim macOS dirty pages, so post-GC footprint ≈ pre-GC plateau; do not chase post-GC drops).
- Resolution rule: footprint run-to-run half-spread is ~10-11MB. A 3-run A/B resolves nothing under ~15MB. If |delta| < 15MB, rerun once; only trust it if both runs agree in sign. For 10-20MB candidate wins, confirm with MEASURE_RUNS=5 before keeping.
- p-value guardrail: never keep on a delta whose p-value is 1.0 even if the MB number looks good (identical-code baselines produced p=1.0 with -7MB deltas; that is noise).

# How to Run

`./.auto/measure.sh` — one iteration ≈ 10-12 min: builds the candidate via config/scripts/build-bench-app.mjs (never build by hand; VITE_EXPOSE_STORE is handled internally and the store-exposure verify is loud), runs 1 warmup discard + 3 A/B runs (settle 90s, window 60s, forced V8 GC at window end, footprint probed via /usr/bin/footprint every tick), prints METRIC lines. The pinned baseline lives at ../bench-bases/orca-mem-rss/Orca.app (OUTSIDE the repo on purpose: electron-builder asar-packs the repo dir, a bundle inside it gets embedded and inflates the candidate ~18MB). MEASURE_KEEP_ARTIFACTS=1 keeps run JSONs for debugging; they land in a mktemp dir printed to stderr at exit.

# Known measurement properties (do not rediscover)

- Artifacts: schema orca.resource-bench-run; per-tick samples have type main/gpu/utility/renderer (NO zygote on darwin); mainProcess aggregate is in-proc (rssBytes bytes); footprintBytes is bytes, integer-MB quantized by the tool default (a future upgrade is footprint -f bytes; optional).
- measure.sh analyzer: sorts ticks by timestamp (overlapping async ticks land out of order), EXCLUDES the final tick (teardown spike +20-60MB in 5/6 runs), bounds the post-GC tail by postGc.startedAt (slice(-5) reached into pre-GC ticks because effective tick period is 3-4s, footprint probes are slow).
- cpuPercent is always 0 on darwin in-app; main_cpu_delta_pct is a placeholder. mainHeapSpaces/mainMemoryUsage are null in packaged apps (attribution failure, non-blocking).
- Combined roles zygote/other contribute 0 on both sides (fine). If a delta prints 0.00 exactly and looks suspicious, check both sides had runs: the analyzer now fails loudly on an empty side.
- Known upstream-class leak already fixed on this branch: terminal error accumulation bound; max-lines ratchets; do not re-audit renderer Maps - a 2026-08-30 audit found all major caches properly capped.

# Files in Scope

- src/main/** memory-relevant subsystems (sqlite sync-database.ts pragmas F2, service lazy-start)
- src/renderer/src/** lazy loading and chunking (F1 warp theme worker teardown useWarpThemeImport.ts, F3 lazy Monaco in pr-files-combined-diff-viewer/body.tsx)
- electron.vite.config.ts chunking
- V8 flags on the bench app main process (--max-semi-space-size=2 gave -36MB RSS in a prior study; test via src/main/index.ts bench-startup-switches pattern already present)

# Off Limits

- .auto/checks.sh (coordinator-owned); .auto/measure.sh analysis logic (if you find a genuine measurement bug, note it in log.jsonl as a comment instead of editing - coordinator applies fixes)
- run-release-memory-benchmark.mjs and resource-metrics-analysis.mjs semantics
- Native module sources unless config-only; docs/**; CI
- The baseline app under ../bench-bases/ (read-only pin)

# Constraints

- ./.auto/checks.sh must pass before any keep.
- No new dependencies. Do not change settle/window/runs/fixture methodology (measure.sh owns it; MEASURE_RUNS=5 env override is allowed for confirmation runs only).
- Marginal keep (|delta| within 15MB)? rerun once before keeping; both must agree in sign.
- No UI interaction while measure runs (perturbs results measurably).
- Log every iteration in results.tsv-style rows in .auto/log.jsonl (status keep/discard, metric, metrics dict, description, as a note).

# What's Been Tried

- 2026-08-30→09-02 harness hardening (see log.jsonl runs 0-5): noise floors +19.17/+17.43/+22.91/-15.38MB RSS on identical code; RSS abandoned as primary 2026-09-02 after footprint pipeline was fixed (parser never worked before: expected KB, tool prints MB).
- F1 (warp worker teardown), F2 (sqlite WAL/page-cache), F3 (lazy Monaco): hypotheses with bisect worktrees pending verdicts (../bisf1 ../bisf2 ../bisf3); treat as unverified leads, verify yourself before keeping.
- Priors: PocketClaw V8 --max-semi-space-size=2 -36MB RSS; sqlite cache_size=-2000 + mmap_size=0 est 5-8MB.

# Loop Rules

Loop until maxIterations (40). Primary metric is king; keep only on confirmed, p-value-supported reductions. Never stop early to ask. If you run out of ideas, re-read ideas.md and combine near-misses. A discarded idea with data beats an untried guess: record negative results in log.jsonl so future iterations do not retry them.
