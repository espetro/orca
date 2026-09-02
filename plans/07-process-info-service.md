# ProcessInfoService and PressureMonitor: One Process Table Reader for the App

Status: draft, for review
Area: `src/main/memory` and `src/main/windows`
Effort: S (phase 1), S-M (phase 2), M (phase 3)

## SMART goals

1. Phase 1 ships in one small PR: the Windows memory collector reads the native process table instead of spawning PowerShell on every poll, with zero change to `MemorySnapshot` consumers.
2. Phase 2 lands a single TTL-cached snapshot service so no RPC call recomputes a host sweep.
3. Phase 3 (separate PR) introduces a typed `PressureSample` feed that the hibernation planner (#16214) can consume.
4. Verifiable numbers: PowerShell/typeperf child spawns per minute on Windows drop to (near) zero, and snapshot p95 latency drops from hundreds of ms to double-digit ms.

## Problem

Windows process sampling still spawns child processes on a 2s poll loop, and memory diagnostics recompute full sweeps per RPC call with no cache. There is commit data available natively but the collector does not use it, and there is no pressure signal feeding any policy.

## Evidence

- Issue #16905: after the #15749 migration, 1 of roughly 5 memory pollers still runs PowerShell. Root cause: `enumerateWindowsProcessResources()` in `src/main/memory/windows-process-resource-collector.ts:26` drives a CIM sweep via `powershell.exe Get-CimInstance` (`:99`) with a `typeperf.exe` fallback (`:116`, `:125`), retried on a 30s backoff (`CIM_RETRY_AFTER_MS`, `:19`). Each poll is a fresh child process spawn.
- The native path exists and is fast: `src/main/windows/windows-process-table.ts` uses `@vscode/windows-process-tree` (Toolhelp32 snapshot, ~16 ms, no child per-poll cost, see the comment at `:19`). It already reports working set bytes (`WindowsProcessRow.memoryBytes`, `:34`) but has no pagefile/commit field.
- CIM latency measured in issue #16905: ~706 ms per Get-CimInstance sweep versus 16 to 34 ms native.
- Issue #16211: overlapping pollers duplicate work.
- `diagnostics.memory` RPC (`src/main/runtime/rpc/methods/diagnostics.ts:8`) calls `runtime.getMemorySnapshot()` with no TTL (`src/main/runtime/orca-runtime.ts:4084`), so each diagnostics panel open runs a fresh sweep.
- A dedup pattern to reuse already exists: `createProcessTableSnapshotReader` / `getProcessTableSnapshot` with in-flight promise plus short TTL, `src/shared/process-table-snapshot.ts:69` and `:187`.
- `MemorySnapshot` already has the typed model: `processCommitMetric` on `MemorySnapshot` (`src/shared/process-stats-types.ts:93`), Windows-only and nullable by contract. `memoryUsagePercent` (`src/shared/process-stats-types.ts:77`, computed in `src/main/memory/host-memory.ts:27`) is display-only. Hibernation is user-triggered only. Issue #16214 (hibernation planner) is blocked on having a pressure signal, i.e. no feedback loop exists today.

## Design

### Phase 1: migrate the collector to the native table (S)

Rewrite `enumerateWindowsProcessResources()` to call `readWindowsProcessTable()` (`src/main/windows/windows-process-table.ts:268`) instead of CIM/typeperf. Extend `WindowsProcessRow` with pagefile/commit bytes; the native module can supply commit, or a supplementary query can fill it. Keep the `ParsedWindowsProcessSample` shape so `windows-process-sample-parsing.ts` consumers are untouched. Drop the PowerShell and typeperf code paths and the backend retry state machine.

### Phase 2: TTL-cached ProcessInfoService (S-M)

Introduce `ProcessInfoService` in `src/main/memory`: a singleton wrapping the sweep with a 1.5 to 2s TTL, built on the exact pattern of `src/shared/process-table-snapshot.ts:62-69` (shared in-flight promise, single parse per TTL window, injectable clock for tests). `runtime.getMemorySnapshot()` (`orca-runtime.ts:4084`) and the diagnostics RPC both read through it, so bursts of panel opens share one sweep.

### Phase 3: PressureMonitor (M, separate PR)

A small monitor that derives typed samples on top of the service:

```ts
type PressureSample = {
  hostCommit: number
  hostAvailable: number
  swapUsed: number
  appPrivate: number
  trend: number // slope over a rolling window
}
```

Consumers subscribe; the hibernation planner (#16214) becomes the first subscriber, turning hibernation from user-triggered-only into a feedback loop. Keep `memoryUsagePercent` display-only in this phase.

## YAGNI (v1 explicitly excludes)

- No cgroup / systemd / sysctl integration or platform-specific pressure APIs beyond commit and available bytes.
- No OOM-kill automation: v1 only publishes samples, it never kills processes or hibernates autonomously.

## Measurement

- PowerShell spawns per minute on Windows, before vs after phase 1: baseline is ~30 spawns per poller per minute at the 2s poll, target is 0 steady state (asserted in tests, below).
- Snapshot latency p95: CIM sweep ~706 ms vs native 16 to 34 ms; confirm via the service's injected clock in tests and a manual timing log on a 100-process dev machine.
- RPC burst: N concurrent `diagnostics.memory` calls must produce 1 sweep per TTL window (unit test on the service).

## Tests (anchors)

- `src/main/windows/windows-process-table.test.ts`: extend for the new commit/pagefile row field.
- `src/main/memory/collector.test.ts`: sample values now sourced from the native reader.
- `src/main/memory/collector-windows-sweep.test.ts`: currently asserts the spawned `powershell.exe` spec (e.g. `:151`, `:192`). Must be updated to assert NO child process is spawned at all.

## Split-into-PRs guidance

- PR 1: phase 1 collector migration plus test updates (small, self-contained, closes the #16905 residue).
- PR 2: phase 2 ProcessInfoService plus `getMemorySnapshot` rewiring.
- PR 3: phase 3 PressureMonitor plus the #16214 planner subscription. Phase 3 must not block 1 and 2.
