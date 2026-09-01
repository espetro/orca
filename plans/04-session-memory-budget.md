# 04: Central SessionMemoryBudget enforced at PTY ingress

Status: draft for upstream discussion
Effort: M
Gating: behind an env flag (e.g. `ORCA_SESSION_MEMORY_BUDGET_MB`) initially, default off
Tracking issues: #16211, #11218

## Problem

The daemon retains terminal memory through six independent caps. Each cap was chosen locally to
bound its own structure, but nothing bounds their product. A single terminal session can retain
on the order of:

| Cap                    | Site                                                         | Value                                                                          |
| ---------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Pending output records | `src/main/daemon/session-output-plane.ts:16`                 | 2MB per session (UTF-16 chars)                                                 |
| Scrollback rows        | `src/shared/terminal-scrollback-policy.ts:1-3`               | 1,000 to 50,000 rows, default 5,000                                            |
| Backlog chars          | `src/shared/terminal-scrollback-policy.ts:33-40`             | `terminalOutputBacklogCapChars` = max(2M, rows x 120), applied only to backlog |
| Cold-restore cache     | `src/main/daemon/cold-restore-payload-cache.ts:14`           | 16MB aggregate                                                                 |
| Checkpoint history     | `src/main/daemon/terminal-history-file-limits.ts:5`          | 200MB per checkpoint (`TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES`)                 |
| Output log             | `src/main/daemon/terminal-history-file-limits.ts:2`          | 5MB per session                                                                |
| Restorable sessions    | `src/main/daemon/terminal-history-restorable-retention.ts:1` | 10,000 sessions                                                                |

Worst case is rows x sessions x copies (pending plane, backlog, cache, checkpoint on disk). The
only damping is accidental: most sessions do not hit every cap simultaneously. When agents do
(scrollback-heavy sessions under many parallel agent runs), the daemon's private bytes scale
linearly with session count and there is no mechanism to say "stop admitting above this line".

## Evidence

- #16211: 16GB Windows host, agents drove committed memory to ~40GB, page thrashing.
- #11218: 135GB reported on a 64GB Mac.
- Both reports show unbounded aggregate growth from many individually-bounded structures, not a
  single leak.

## Design

Add one `SessionMemoryBudget { perSessionBytes, perDaemonBytes }` owned by the daemon.

1. Consultation points. The budget is consulted at exactly two places:
   - PTY ingress: before attaching a new session's output plane, admit only if
     `sessionBytes + estimatedIncoming <= perSessionBytes` and daemon aggregate
     `<= perDaemonBytes`.
   - Checkpoint enqueue: before enqueuing a checkpoint (`terminal-history-file-limits.ts`
     consumers), reject or trim if the enqueue would exceed the budget.
2. Degrade path, in strict order when over budget:
   - Shed the cold-restore cache first (`ColdRestorePayloadCache` already has eviction
     plumbing, `cold-restore-payload-cache.ts:34-37`).
   - Shrink the grid window next (reduce effective scrollback rows via
     `normalizeDesktopTerminalSnapshotRows`, lower row budgets).
   - Never drop pending records for attached sessions; those clients would see torn output.
3. The budget module decides admission only. Existing modules keep deciding eviction mechanics:
   `session-output-plane.ts` still owns its pending-record drop-and-overflow flag,
   `ColdRestorePayloadCache` still owns its LRU eviction. The budget is a coordinator, not a
   reimplementation.

## YAGNI

- No user-facing settings UI in v1. Env flag only.
- No cross-process accounting. The budget covers the daemon process only; renderer and helper
  processes are out of scope until a future iteration.

## SRP

The budget decides admission. Existing modules decide eviction mechanics. The budget never
reaches into a module's internal structures; it only answers "may this allocation proceed" and
"which tier of shedding to trigger now".

## Measurement

- Primary metric: daemon aggregate private bytes as a function of the number of active sessions,
  sampled before and after enabling the flag. Target: aggregate plateaus near `perDaemonBytes`
  instead of scaling linearly.
- Benchmark pattern exists: `src/main/workspace-snapshot-pruning.bench.test.ts` shows the repo's
  bench-test style; a `session-memory-budget.bench.test.ts` would follow it.
- Test anchors, module-local only:
  - `src/main/daemon/daemon-stream-data-batcher.test.ts` (adjacent batcher behavior must not
    change).
  - `src/main/daemon/session-output-plane.test.ts` (pending-plane tests; new tests live beside
    the budget module).
  - New `session-memory-budget.test.ts` colocated with the module, following the repo
    module-local test convention.

## Effort

M. Two real design decisions (degrade order, admission estimate) plus wiring at two call sites
and tests. Not S because degrade ordering needs agreement with maintainers on which retained
copies are safest to shed.
