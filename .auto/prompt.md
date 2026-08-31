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

Clean floor (run 3, log.jsonl): harness group-kill fix + warmup discard (3-run short-settle A/B, MIN_AB_RUNS-compliant) + no UI interaction during runs gave main_rss_delta_mb=-15.38 on identical code - noise, not signal. Warmup outlier is gone (medians 172.0/168.5/205.6/128.9/170.0/175.6) but the half-spread of per-run medians is still ~38MB: a single 3-run A/B cannot resolve deltas below that. RSS decays through the 60s window in every spawn (last < boot) - we sample a draining transient. Earlier floors: +17.43 (run 1, prod Orca closed, no warmup), +22.91 (run 2, harness pre-fix, UI clicks during run). Treat |delta| < 38MB as unresolved in a 3-run A/B; rerun or raise --runs when near it.

Measurement-metric assessment (2026-08-31, research-backed):
- RSS on macOS is the wrong primary: Chromium/Electron docs say resident set "is not what one would expect" (compressed pages); our footprintBytes is null because `ps -o phys_footprint=` is not a valid keyword on modern macOS (resource-recorder.ts:165 falls back to null - this is a keyword problem, NOT an entitlement problem).
- `/usr/bin/footprint -p <pid>` works on this host and reports real phys_footprint (dirty+clean). Best upgrade: sample it per tick in resource-recorder alongside ps. Second-best: proc_pidinfo(PROC_PIDTASKINFO) via a small native/FFI helper (returns ~96 bytes struct; phys_footprint field).
- heap_used_delta_mb misses native memory (sqlite mmap, buffers, scrollback); workingSetKb per role is the best per-role proxy we currently collect.
- Chrome team practice: force GC before the dump (CDP HeapProfiler.collectGarbage or --js-flags=--expose-gc), then measure - kills the decay-transient problem at the source. Worth wiring into the window protocol: measure right after a forced GC instead of averaging the drain.

Priors with verdicts pending from separate bisects; treat as hypotheses, not facts (see ideas.md):
- 2026-08-31: clean floor -15.38MB (noise); half-spread ±38MB dominates (see What's Been Tried).
- F1 warp theme worker teardown
- F2 sqlite WAL + page-cache cap in sync-database.ts
- F3 lazy Monaco loading

# Loop Rules

Autoresearch defaults apply: loop until maxIterations, primary metric is king, annotate asi. Every run already uses the full settle 120 / window 60 protocol plus a warmup discard. A single 3-run result is decision-grade ONLY above ~38MB (the per-run median half-spread, run 3); rerun once (or use --runs 5 via MEASURE extra runs) when a delta is inside that. Never click into or interact with the app while measure runs - UI interaction measurably perturbed run 2.
