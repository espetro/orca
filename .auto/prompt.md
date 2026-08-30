# Objective

Reduce main-process RSS delta at idle (candidate vs pinned baseline app) in the no-editor fixture, without regressing combined RSS across all roles. Primary metric is king: only confirmed reductions in `main_rss_delta_mb` matter; keep others from getting worse.

# Metrics

- Primary: `main_rss_delta_mb` (MB, candidate main-process rssBytes median minus baseline median; negative = improved, magnitude of MB).
- Secondary: `combined_rss_delta_mb` (main process + per-role workingSetKb medians), `heap_used_delta_mb` (main-process heapUsedBytes median delta).
- macOS footprint is null in artifacts (entitlement issue): all verdicts ride on rssBytes / workingSetKb / heapUsedBytes. Do not chase footprint.

# How to Run

`./.auto/measure.sh` builds the candidate via `config/scripts/build-bench-app.mjs` (renderer-only when `out/renderer/assets` exists, else full), benchmarks against the pinned baseline (`ORCA_BENCH_BASE` or `.auto/base-app/Orca.app`), and prints the three METRIC lines. Screen ~6-8 min; a primary improvement of >= 3 MB auto-escalates to a longer-window confirmation (~15-20 min).

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
- Do not change benchmark methodology: settle/window params and fixture stay as measure.sh sets them.
- Never build the app by hand or without `build-bench-app.mjs` (store exposure gotcha: VITE_EXPOSE_STORE is handled internally; a raw electron-vite build produces a broken bench app).

# What's Been Tried

Priors with verdicts pending from separate bisects; treat as hypotheses, not facts (see ideas.md):
- F1 warp theme worker teardown
- F2 sqlite WAL + page-cache cap in sync-database.ts
- F3 lazy Monaco loading

# Loop Rules

Autoresearch defaults apply: loop until maxIterations, primary metric is king, annotate asi. Extra rule: any keep decided on the 3-run screen must be re-confirmed with a full-length (settle 20 / window 60) run before finalize; measure.sh does this automatically on escalation, but if you keep based on a screen-only result, rerun measure.sh before finalizing.
