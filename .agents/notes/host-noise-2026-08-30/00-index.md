---
tags:
  - orca
  - memory
  - research
  - host-noise
  - index
---

# Index: Host-noise research 2026-08-30

Three READ-ONLY deep-dives produced after a host memory audit. Each note has TL;DR, root-cause analysis with file:line refs, evidence-backed failure mode, reproducer, suggested minimum fix with code shape, ranked file/risk list, and fork-positioning notes.

## Notes

- `01-daemon-terminal-leak.md` — Real Orca daemon bug (185 leaked `orca-tcc-login`/zsh shells, ~950MB). Two-layer: TCC-wrapper pgid sweep misses inner shell + daemon survives app updates. Upstream #13764 confirms; minimum fix: expose `file` on SubprocessHandle, branch teardown to `groupMode:'descendants'` for wrapped leaders, periodic reap, appVersion SIGTERM. We own first-filer of the fix PR.
- `02-orphaned-bench-procs.md` — Our own `run-release-memory-benchmark.mjs` (~45 orphan Electron procs, ~225MB). Root-pid-only kill on `detached:false`; CDP-target crash skips clean teardown; no SIGINT/SIGTERM handlers. Unfiled upstream — we own first-filer. Minimum fix: `detached:true` + group signal via `src/shared/child-process/process-tree-termination.ts` + try/catch around `takeHeapSnapshotSummary` + `pickFreePort` + pre-run `reapLeftovers` sweep.
- `03-long-run-renderer-growth.md` — Renderer 465MB after 1d4h. Three ranked suspects: (1) unbounded `appendTerminalErrorMessage` matching upstream #15241, fix in PR #15306 not yet in v1.4.188; (2) SSH/remote PTYs excluded from hidden-view parking per #8652 (CLOSED-with-gap); (3) recovery maps never pruned on close. Plus no long-run ring buffer for crash reports. Land #15306 verbatim = cleanest free PR.

## Combined fork positioning ("less memory usage")

All three issues inflate the ~20MB noise floor recorded in `memloop/.auto/log.jsonl`. Suggested order:

1. Land #2 (our harness bug) on `memloop` lane → re-baseline. Drop noise floor.
2. File upstream PR for #2 → share with community (they all hit this).
3. Land #3-suspect-1 (`#15306` verbatim) on `main` → drop renderer baseline.
4. File upstream PR for #1 → biggest user-facing win, daemon generational + TCC-wrapper fix.
5. Wire #3-instrumentation (long-run ring buffer) before running the autoresearch loop on a production user's machine so verdicts carry time series into crash reports.

## Cross-references

- Autoresearch session files: `~/Documents/prjcts/_own/orca-mem-worktrees/memloop/.auto/` (`prompt.md`, `measure.sh`, `ideas.md` host-noise section, `log.jsonl` baseline sanity record).
- Handoff that started this thread: `~/.local/state/maki/plans/select-uncommon-lamprey.md` and `~/.local/state/maki/handoffs/orca-mem-obs-bisect.md`.
- Memory tag `host-noise` has the working summary.
