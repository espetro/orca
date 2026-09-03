# Report 1: Memory Measurement Harness & Host-Noise Elimination

Date range: Aug 29 - Sep 1, 2026
Branch: `exp/mem-observability` + `exp/mem-autoresearch` (NOT yet merged to main)
Upstream baseline: stablyai/orca main

## 1. Context

The original premise was simple: a baseline Orca instance reads ~500MB RSS and we wanted to tune
it down on this fork. The machine is an 8GB M1 MacBook Pro. The first attempts at measuring any
candidate change failed for a reason that had nothing to do with the app: the measurement loop
itself was untrustworthy. Ad-hoc `ps` reads on a noisy host, a benchmark harness that leaked its
own Electron processes, and a noise floor that was larger than any plausible optimization delta
made every result meaningless. The track pivoted deliberately: build a trustworthy, fast,
self-validating measurement harness first; tune the app second.

## 2. Spotting the problems

Problems surfaced in sequence, each discovered by evidence rather than assumption:

- **The harness was polluting the host.** `run-release-memory-benchmark.mjs` killed only the root
  Electron pid (`detached: false` means children share the parent's pgid; POSIX `child.kill` is
  root-only). ~45 orphaned Electron processes (~225MB) accumulated across runs. A CDP-target crash
  mid-snapshot (`takeHeapSnapshotSummary` "Target closed") escaped `runOnce` and skipped teardown
  entirely; `DEFAULT_CDP_PORT = 9223` was fixed, so a leftover tree blocked the next run.
- **The host was polluting the measurements.** A host-noise audit (Aug 30) found ~185 stale
  `orca-tcc-login`/zsh shells (~950MB) leaked by Orca's own daemon, plus the production Orca
  instance running concurrently during benchmarks.
- **The numbers were noise.** Identical binaries A/B'd against each other produced deltas of
  +19.17MB, +17.43MB, +22.91MB. First-run-after-sweep cold transients hit 244MB against a 108-127MB
  cluster. RSS decayed monotonically through every 60s sampling window. Any "result" smaller than
  ~40MB was uninterpretable.
- **Metric tooling was broken at the OS level.** `ps -o phys_footprint=` silently returns nothing
  on modern macOS (keyword removed), so `resource-recorder.ts:165` produced `footprintBytes: null`
  on every tick with no error.
- **A packaging gotcha corrupted early baselines.** electron-builder asar-packs the whole repo
  dir; an early baseline app stored inside the repo got embedded into candidates, inflating RSS
  ~18MB. Bench bases now live outside the repo.

## 3. Analysis

Three analyses drove the design:

**Noise decomposition.** Controlled null A/B runs (identical binary vs itself) isolated the noise
terms: first-run warmup (dominant), progressive GC drain through the sampling window, and host
load. Closing the production Orca instance barely moved the floor (+19.17 -> +17.43MB), proving
the noise was mostly in the protocol, not the environment.

**Methodology research.** Chromium's memory-infra practice (forced GC before deterministic
dumps), nonparametric statistics for skewed perf data (Mann-Whitney / Cliff's delta over per-run
medians), and the karpathy autoresearch pattern (fixed budget, keep-if-strictly-better) were
reviewed with two research subagents and shaped the verdict logic.

**Root-cause deep-dives.** Three read-only investigations (`.agents/notes/host-noise-2026-08-30/`)
established which host-noise sources were Orca bugs vs harness defects:

1. Daemon terminal-session leak (real Orca bug, two-layer: macOS TCC `login -flpq` wrapper
   setsid's the inner shell out of the PTY pgid sweep; the daemon survives app updates and never
   reaps prior generations). Matches upstream #13764; we hold a minimum-fix design (expose `file`
   on SubprocessHandle, `groupMode: 'descendants'` teardown for wrapped leaders, periodic reap,
   SIGTERM prior daemon generation on version mismatch).
2. Orphaned bench procs (our harness; unfiled upstream) - fixed in-track, see below.
3. Long-run renderer growth (465MB after 1d4h): unbounded terminal-error accumulation (upstream
   #15241, fix exists in open PR #15306, not in v1.4.188), SSH/remote PTYs excluded from
   hidden-view parking (#8652 closed-with-gap, 10-20MB per unparked scrollback tab), and recovery
   maps never pruned per-tab.

A parallel coverage study (`.agents/notes/resource-coverage-2026-08-31/`) mined upstream history
to size the prize: directly resource-tagged work is 3.86% of all 12,838 upstream PRs but 21.98%
of the last 24 months; with lateral topics (jank, freezes, slow startup, fleet scaling) the
addressable share of recent issue load is ~25-35%, and maintainer investment is accelerating
(304 resource-fix PRs in 6 months). Verdict: worth the investment.

## 4. Solutions implemented

All on `exp/mem-observability` (lanes M1-M6, merged Aug 30 09:39-09:43) plus hardening on
`exp/mem-autoresearch`:

| Commit                      | What it added                                                                                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `025b2fbbe9`                | Pure ps/pmset/vm_stat parsers + injectable execFile helper (M1)                                                                                                                                                          |
| `a140f0cd9b`                | `src/main/metrics/resource-recorder.ts`: in-app tick loop, ring buffer, dump; singleton behind `ORCA_RESOURCE_RECORDER=1` (M1)                                                                                           |
| `a823dc4ec1`                | `window.__orcaE2E__.resources.{dump,mark}` bridge over preload IPC, e2e-gated (M2)                                                                                                                                       |
| `0e4230825f`                | `resource-metrics-analysis.mjs` comparison CLI: IQR-disjoint verdicts (improved/regressed/inconclusive) + 8 deviance flags (M3)                                                                                          |
| `c4be8530b5`                | Harness v2: `--ab A B --runs 3` (min 3 enforced), interleaved A,B,B,A,A,B order, `--settle-s`/`--window-s`, per-run `orca.resource-bench-run/1` artifacts, ps cross-checks (M4)                                          |
| `1122c6b0e8`                | `bench:compare-memory` script wiring                                                                                                                                                                                     |
| `508f7c8eca`                | `RESOURCE-BENCH-PLAYBOOK.md`: metric semantics, verdict rules, confounds, null-test-first rule (M5)                                                                                                                      |
| `ae849f26aa`                | Committed null A/B validation artifacts - verdict `inconclusive` on every metric, as required (M6)                                                                                                                       |
| `88612f738d` + `251f005f06` | ps `phys_footprint` keyword removal handled: parsers accept null, CLI unwraps artifacts                                                                                                                                  |
| `c229b7065e`                | Harness hardening: detached spawn + process-tree group kill, `reapLeftovers` pre-run sweep, `pickFreePort` (replaces fixed 9223), SIGINT/SIGTERM/exit reaping, CDP snapshot failures degrade to null instead of aborting |

Protocol facts baked in: 120s settle mandatory (shorter samples the GC transient), discarded
warmup run after every process sweep, no UI interaction during measurement, bench bases outside
the repo, `ORCA_E2E_USER_DATA_DIR` + isolated HOME for the single-instance lock.

## 5. Computed deltas

- **Noise floor**: +19.17MB (run 0) -> -15.38MB (run 3, clean protocol). The absolute value is
  symmetric noise; the point is the resolution limit tightened to a understood ~38MB per-run
  median half-spread, with the warmup outlier eliminated (244MB -> 108-127MB cluster).
- **Process hygiene**: harness no longer leaks ~45 Electron procs (~225MB) per session; fixed
  CDP-port collisions eliminated; pre-run sweep fails loudly on stale processes.
- **Measurement capability**: from ad-hoc `ps` reads with no validation, to a validated
  3-run interleaved A/B with in-app per-process recorder, artifact schema, statistical verdicts,
  deviance flags, and a committed null-test. Each iteration costs ~16-18min and is reproducible.
- **Host knowledge**: ~950MB of daemon-leaked shells and their root cause documented with a
  ready fix design (first-filer position on upstream #13764).

## 6. What this bought relative to upstream

Upstream has no committed benchmark protocol, playbook, or null-test artifacts; their memory
work is done with ad-hoc harnesses (their own issues describe orphans and noise). This fork has:
a measurement harness that can accept or reject a candidate RSS change with stated confidence,
per-run JSON artifacts suitable for trend analysis, and three upstream-quality bug investigations
(#13764 fix design, #15241/#15306 cross-reference, #8652 gap analysis) that upstream itself has
not connected.

## 7. Caveats / not yet done

- **The original goal is still open.** No RSS-reduction intervention has been applied to the app
  yet; the bisect apps built for F1/F2/F3 hypotheses never got completed A/B verdicts.
- ~38MB half-spread means single 3-run A/Bs cannot resolve small deltas. Recorded next steps:
  raise to 5+ runs, switch primary metric to `/usr/bin/footprint -p` (works where the ps keyword
  is gone).
- Harness work is unmerged (`exp/mem-autoresearch` branch); needs merging before it protects
  future work on main.
