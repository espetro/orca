# Resource-Usage Coverage: Overview

Date: 2026-08-31
Repo: stablyai/orca
Question: _What % of issues and PRs would be solved by improvements to Orca's
resource usage (RSS, CPU, leaks)?_

**Short answer.** Directly-tagged share is small (≈ 4% of all PRs, ≈ 18% of
keyword-touching issues), but recent activity is concentrated and accelerating
(304 resource-fix PRs merged in 6 months, 122 still open). When you add the
_lateral_ topics — UI jank, freezes, slow startup, input lag, "many
terminals/worktrees/agent fleet" scaling, slow remote, daemon accumulation —
the share of recent issue load that would be materially improved by the same
fixes climbs to **≈ 25-35%**. The maintainers themselves treat this as
structural: meta-issue #17033 proposes "resource-lifetime conventions" and
release notes since v1.4.184 carry a "## Performance" heading in 17 of the
last 30 releases.

**Verdict: worth the investment.** Three independent signals converge
(direct, lateral, and strategic), and the codebase already has the answer —
bounded primitives — what's missing is coverage.

---

## The headline numbers

| Lens                                                         | Total                 | Resource-related                     | %                                                 |
| ------------------------------------------------------------ | --------------------- | ------------------------------------ | ------------------------------------------------- |
| All PRs in repo                                              | 12,838                | 495                                  | **3.86%** (lower bound — pre-2026 under-captured) |
| PRs sampled in last ~24 mo                                   | 2,252                 | 495                                  | **21.98%**                                        |
| Issues matching memory/leak/RSS/CPU keywords                 | ~647                  | direct hits                          | ~98% open (49/50 for memory & leak)               |
| Lateral-impact issues (freeze, jank, slow startup, many-\*…) | 1,606 keyword-touched | 46 of top 80 classified with overlap | ~25-35% combined                                  |

PR cadence in 2026 (merged resource-fix PRs by month): Apr 7 → May 19 →
Jun 23 → **Jul 105** → **Aug 150 (partial)**. 122 open resource-fix PRs as of
2026-08-31.

## What this maps to (lateral POVs)

Eleven lateral areas share root causes with resource pressure. Each is a
different symptom of the same class: unbounded references, intervals,
listeners, or process trees that grow with uptime.

1. Cold-start / TTI — driven by the 1.6M-line `orca-runtime.ts` and eager
   renderer bootstrap.
2. UI responsiveness / jank / input lag — same store-Map bounds that fix
   leaks also cap listener fanout.
3. Battery / power — coalescing intervals drops idle CPU on battery.
4. Multi-agent / fleet scalability — bounded queues ring-buffer per-tenant.
5. Cross-platform consistency — macOS TCC PTY leak, Windows conpty, Linux
   `systemd-oomd` all share `process-tree-termination.ts`.
6. CI/CD determinism — the benchmark harness leaks processes and
   contaminates every measurement.
7. Reliability / crash recovery — time-bucketed memory ring makes problems
   visible _before_ crashes.
8. Cloud cost (`orca serve`) — orphan PTYs are billable RSS on a user's VPS.
9. UX perception of "snappiness" — listener-leak fix IS the re-render fix.
10. Security / sandbox — bounded event sources narrow attack surface.
11. Developer rebuild / edit-time memory — splitting the runtime serves
    cold-start, fleet, dev rebuild, and test runtime at once.

The cross-cutting lever is **bounded primitives**: `bounded-map`,
`bounded-output-sink`, `bounded-secure-json-file`, ring buffers in
`memory/collector`, `DISPATCHER_CONTROL_QUEUE_MAX_*`. Where applied, leaks
are provably closed. Where missing, leak and jank co-occur.

## Subsystems with most leak pressure

- **Terminal lifecycle** (PTY, xterm, orphan adoption) — high
- **Main `orca-runtime.ts`** (336 `new Map`/`new Set`, 50 timers) — high
- **Renderer zustand slices keyed by ephemeral ids** — high
- **Long-lived terminal daemon** (TerminalHost, HistoryManager, headless
  emulator) — high
- Worktree / git lifecycle, source-control caches, filesystem watchers,
  Electron windows, network clients — medium
- Skills, i18n, telemetry, speech — low (already bounded)

## Top files touched by resource-fix PRs

`src/main/runtime/orca-runtime.ts` (54 PRs), `src/main/index.ts` (27),
`src/preload/index.ts` (25), `src/main/ipc/pty.ts` (19),
`src/main/daemon/daemon-pty-adapter.ts` (15),
`src/main/ssh/ssh-relay-session.ts` (15),
`src/renderer/src/store/slices/worktrees.ts` (17),
`src/renderer/src/store/slices/terminals.ts` (16),
`src/renderer/src/components/terminal-pane/pty-connection.ts` (16),
`config/reliability-gates.jsonc` (22).

## Three concrete recommendations

1. **Fix the bench harness first.** `config/scripts/run-release-memory-benchmark.mjs`
   leaks ~45 Electron procs per run (root-pid-only kill, no pgid group,
   fixed `DEFAULT_CDP_PORT=9223`). Until this is repaired, no RSS gate in CI
   is trustworthy — every "we lowered memory" measurement is confounded.

2. **Land the upstream quick-win.** PR #15306 bounds
   `terminal-error-accumulation.ts:17` — single short diff that closes the
   rank-1 renderer leak suspect. Already exists upstream.

3. **Schedule the `orca-runtime.ts` split.** 1.6M-line file (with explicit
   `eslint-disable max-lines` concession at line 1) is the single biggest
   shared root cause across cold start, fleet scalability, dev rebuild, test
   runtime, and leak surface area.

## Where to read more

For the full walkthrough — query lists, all 495 resource-fix PRs, all 16
subsystem risk assessments, all 46 lateral issues with quotes, evidence
files, and user pain points — see the companion document:

**`.agents/notes/resource-coverage-2026-08-31/DETAILED.md`**

That document also contains the method, caveats, sampling biases, and the
synthesis logic step by step.

## Sources

Four parallel research streams contributed:

- Issue keyword sweep (memory/leak/RSS/CPU/perf/unresponsive)
- PR keyword sweep (495 resource-fix PRs classified)
- Subsystem surface-area sweep (16 subsystems with evidence files)
- Lateral POV sweep across issues + codebase (11 lateral areas, 46 lateral
  issues classified)

Plan file: `.agents/plans/2026-08-31-resource-usage-issue-coverage.md`
Detailed report: `.agents/notes/resource-coverage-2026-08-31/DETAILED.md`
This overview: `.agents/notes/resource-coverage-2026-08-31/OVERVIEW.md`
