# Objective

Reduce main-process RSS delta at idle (candidate vs pinned baseline app) in the no-editor fixture, without regressing combined RSS across all roles. Primary metric is king: only confirmed reductions in `main_rss_delta_mb` matter; keep others from getting worse.

# Metrics

- Primary: `main_rss_delta_mb` (MB, candidate main-process rssBytes median minus baseline median; negative = improved, magnitude of MB).
- Secondary: `combined_rss_delta_mb` (main process + per-role workingSetKb medians), `heap_used_delta_mb` (main-process heapUsedBytes median delta).
- macOS footprint is null in artifacts (entitlement issue): all verdicts ride on rssBytes / workingSetKb / heapUsedBytes. Do not chase footprint.

# How to Run

`./.auto/measure.sh` builds the candidate via `config/scripts/build-bench-app.mjs` (renderer-only when `out/renderer/assets` exists, else full), benchmarks against the pinned baseline (`ORCA_BENCH_BASE` or `../bench-bases/orca-mem-rss/Orca.app` outside the repo; it must not live under the repo because electron-builder packs the repo directory into the asar), and prints three METRIC lines: `main_rss_delta_mb` (primary), `combined_rss_delta_mb`, `heap_used_delta_mb`. One 3-run A/B with settle 120s / window 60s, roughly 16-18 min per iteration. There is NO screen-then-escalate ladder: the app needs about 2.5 min after the fixture to reach steady-state RSS (progressive GC), so short-settle screens measured a transient, not idle RSS. Do not shorten the settle.

# Files in Scope

- `src/main/**` memory-relevant subsystems
- `src/renderer/src/**` lazy loading and chunking
- vite / electron-vite config
- Known leads:
  - `src/main/sqlite/sync-database.ts` (WAL / page-cache / mmap tuning, F2)
  - Warp theme worker teardown: `src/renderer/src/components/settings/useWarpThemeImport.ts` (F1)
  - Monaco loading: `src/renderer/src/components/github-item-dialog/inspect-pull-request/pr-files-combined-diff-viewer.tsx` and `pr-files-combined-diff-body.tsx` (F3)

# Off Limits

- `.auto/**` except `log.md` / `ideas.md` the tools manage; never touch `.auto/checks.sh` (coordinator owns it)
- `config/scripts/run-release-memory-benchmark.mjs` and `config/scripts/resource-metrics-analysis.mjs` semantics (only the already-done loadDump glob extension is in)
- `config/scripts/resource-metrics-analysis.mjs` itself (another agent is editing it concurrently)
- Native module sources unless the change is config-only
- `docs/**`, CI

# Constraints

- `./.auto/checks.sh` runs automatically and must pass.
- No new dependencies.
- Do not change benchmark methodology: settle/window params, fixture, and the single 3-run protocol stay as measure.sh sets them.
- If a keep decision looks marginal (delta within the run-to-run spread seen in log.jsonl), rerun measure.sh once before keeping.
- Never build the app by hand or without `build-bench-app.mjs` (store exposure gotcha: VITE_EXPOSE_STORE is handled internally; a raw electron-vite build produces a broken bench app).
- Never store app bundles under the repo directory: electron-builder asar-packs the repo, so any bundle inside it gets embedded in the candidate app and inflates its RSS (this polluted an early baseline run).

# What's Been Tried

Baseline sanity (run 0 in log.jsonl): candidate vs pinned base with IDENTICAL code measured +19.17MB. That number is the machine noise floor, not a signal: per-run main RSS medians ranged 112-226MB across six identical runs. Treat |delta| < 20MB as noise unless the loop runs on a quieter machine; consider raising --runs for marginal candidates. Known host-noise sources and the pre-run sweep are listed in ideas.md under "Host-noise issues"; sweep them before benchmarking and note machine load in asi.

Priors with verdicts pending from separate bisects; treat as hypotheses, not facts (see ideas.md):
- F1 warp theme worker teardown
- F2 sqlite WAL + page-cache cap in sync-database.ts
- F3 lazy Monaco loading

# Loop Rules

Autoresearch defaults apply: loop until maxIterations, primary metric is king, annotate asi. Every run already uses the full settle 120 / window 60 protocol, so a single measure.sh result is decision-grade EXCEPT near the ~20MB noise floor documented in What's Been Tried; rerun once when a delta is inside it.
