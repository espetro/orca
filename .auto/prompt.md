# Objective

Reduce idle process phys_footprint (main, renderer, and forked helper processes) of the candidate app vs the pinned baseline in the fixture, without regressing performance or stability. Confirmed reductions in `main_footprint_delta_mb`, `renderer_footprint_delta_mb`, and `fork_footprint_delta_mb` advance the branch.

# Metrics (read METRIC lines from measure.sh output)

- Primary: `main_footprint_delta_mb`, `renderer_footprint_delta_mb`, `fork_footprint_delta_mb` — per-run median role phys_footprint (from `/usr/bin/footprint -p <pid>`), median of 3 runs per side, A minus B. Negative = better. Phys_footprint is pre-compression dirty+clean pages: the macOS-correct memory metric.
- Secondary (must not regress): `combined_rss_delta_mb` (all roles workingSetKb), `heap_used_delta_mb`, `main_footprint_pvalue` (Mann-Whitney U).
- Resolution rule: footprint run-to-run half-spread is ~10-11MB. A 3-run A/B resolves nothing under ~15MB. If |delta| < 15MB, rerun once; only trust it if both runs agree in sign. For 10-20MB candidate wins, confirm with MEASURE_RUNS=5 before keeping.
- p-value guardrail: never keep on a delta whose p-value is 1.0 even if the MB number looks good (identical-code baselines produced p=1.0 with -7MB deltas; that is noise).

# How to Run

`./.auto/measure.sh` — one iteration ≈ 10-12 min: builds the candidate via config/scripts/build-bench-app.mjs (never build by hand; VITE_EXPOSE_STORE is handled internally and the store-exposure verify is loud), runs 1 warmup discard + 3 A/B runs (settle 90s, window 60s, forced V8 GC at window end, footprint probed via /usr/bin/footprint every tick), prints METRIC lines. The pinned baseline lives at ../bench-bases/orca-mem-rss/Orca.app (OUTSIDE the repo on purpose: electron-builder asar-packs the repo dir, a bundle inside it gets embedded and inflates the candidate ~18MB). MEASURE_KEEP_ARTIFACTS=1 keeps run JSONs for debugging; they land in a mktemp dir printed to stderr at exit.

# Known measurement properties (do not rediscover)

- Artifacts: schema orca.resource-bench-run; per-tick samples have type main/gpu/utility/renderer/fork (NO zygote on darwin); mainProcess aggregate is in-proc (rssBytes bytes); footprintBytes is bytes, integer-MB quantized by the tool default.
- measure.sh analyzer: sorts ticks by timestamp (overlapping async ticks land out of order), EXCLUDES the final tick (teardown spike +20-60MB in 5/6 runs), bounds the post-GC tail by postGc.startedAt.
- Negative results inventory (DO NOT RETRY):
  - `--single-process`: Drops Chromium multi-process isolation and crashes with Node-PTY, webviews, and CDP. Unusable in Electron.
  - Direct bytecode packaging (`bytenode`): Brittle V8 version coupling, breaks sandboxed ESM renderer, strips symbolication from crash telemetry.
  - Forced V8 GC: Does NOT return dirty pages to macOS kernel immediately without purge.
- Known upstream-class leak already fixed on this branch: terminal error accumulation bound; max-lines ratchets; do not re-audit renderer Maps - a 2026-08-30 audit found all major caches properly capped.

# Files in Scope

- `src/main/startup/host-memory-budget.ts` (host RAM budget tiers & thresholds)
- `src/main/startup/disabled-chromium-features.ts` & `src/main/startup/configure-process.ts` (Chromium feature flags & GPU limits)
- `src/main/startup/renderer-heap-headroom.ts` (V8 old space and flags)
- `src/renderer/src/lib/pane-manager/terminal-webgl-hidden-retention.ts` (WebGL GPU context retention)
- `src/renderer/src/components/terminal/background-terminal-worktree-mount.ts` (tab deferral)
- `src/main/daemon/daemon-session-scrollback-window.ts` (detached session retention)
- `src/main/ai-vault/session-scanner-service-client-state.ts` (idle service worker timeout)
- `electron.vite.config.ts` chunking and lazy loading seams

# Off Limits

- .auto/checks.sh (coordinator-owned); .auto/measure.sh analysis logic (if you find a genuine measurement bug, note it in log.jsonl as a comment instead of editing - coordinator applies fixes)
- run-release-memory-benchmark.mjs and resource-metrics-analysis.mjs semantics
- Native module sources unless config-only; docs/\*\*; CI
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
