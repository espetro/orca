# ProcessRegistry: single owner for child process termination

## Problem

Child process termination logic is implemented three times in parallel, and most spawn sites
bypass the one shared helper entirely. Shutdown and error paths therefore have no authoritative
list of "which processes does this app own, and how do I kill each one," which produces orphaned
helper processes reported in multiple issues.

## Evidence

Three parallel termination stacks exist today:

- `src/shared/child-process/process-tree-termination.ts` (shared tree-kill primitives, with tests
  in `process-tree-termination.test.ts`).
- `src/main/pty-descendant-termination.ts`, 375 lines, with its own process snapshot, grace
  period, and SIGTERM then 2s then SIGKILL ladder.
- `src/main/providers/windows-pty-job-membership.ts`, Windows job objects. This one is
  legitimate platform-specific ownership and should stay.

Spawn-site discipline is weak: 480 files under `src/` import `node:child_process`, and only 61
files reference `run-process` (`src/shared/child-process/run-process.ts`). That leaves a long tail
of raw spawns. Concrete orphans:

- `src/main/browser/agent-browser-bridge.ts:2437`, `:2503`, `:2702` call raw `.kill()` on the
  direct child only, no tree kill, so grandchildren survive.
- `src/main/computer/macos-native-provider-transport.ts:117-129` spawns with `detached: true`,
  calls `provider.unref()`, and drops the returned handle. When the main process exits or the
  transport errors, the detached helper keeps running. This is issue #9141 (roughly 200 leftover
  helper processes accumulating over ~3h). Issues #9530 and #9138 describe related orphan
  classes.

A guard exists but only as a test: `src/shared/child-process/child-process-import-boundary.test.ts`
checks imports against `__fixtures__/child-process-import-allowlist.txt`. Test-enforced boundaries
do not fail a developer's local lint run and are easy to opt out of.

## Design

Phase 1: registry module, e.g. `src/shared/child-process/process-registry.ts`.

```ts
register(pid: number, owner: string, strategy: TerminationStrategy): () => void
unregister(pid: number): void
listByOwner(owner: string): RegisteredProcess[]
```

`TerminationStrategy` is a tagged union over the three existing killers (shared tree termination,
pty descendant ladder, Windows job object membership). Spawning code registers at spawn time and
receives an auto-unregistering disposer. Shutdown and crash-recovery paths consult
`listByOwner` and route to the stored strategy instead of re-deriving process trees.

Phase 2: enforcement. Promote the import boundary from a test to an oxlint plugin under
`config/oxlint-plugins/`, and add a shrink-only ratchet counting raw `spawn`/`exec`/`.kill()`
calls outside the allowlist. The mechanics are copied from
`config/scripts/check-max-lines-ratchet.mjs`: the checked-in count may only decrease; increasing
it fails CI.

## YAGNI

- v1 is bookkeeping plus wiring, not a new kill engine. All three existing termination strategies
  are reused as-is; the registry only routes to them.
- Windows job objects stay exactly where they are; the registry just records them as the strategy
  for the pids they own.
- No daemonization supervision, restart policies, or health checks.

## SRP

The registry does not kill. It records ownership and routes to existing killers. Termination
semantics remain in `process-tree-termination.ts`, `pty-descendant-termination.ts`, and
`windows-pty-job-membership.ts`.

## Measurement

- Orphan counts in the #9138 and #9141 repro scenarios drop to zero after the affected spawn
  sites register and shutdown consults the registry.
- The ratchet number (raw spawn/kill sites outside the allowlist) can only shrink; it starts at
  the current measured count so the PR itself is zero-risk.

## Effort

M. Touches many files (registration at spawn sites), so propose as an issue first and get
maintainer buy-in before opening a PR.

## Tests

Module-local only:

- `src/main/pty-descendant-termination.test.ts` (existing, extended for registry routing)
- new `agent-browser-orphan-sweep.test.ts` asserting no bridge session process survives a
  forced teardown
- `src/main/computer/macos-native-provider-client.test.ts` extended to assert provider pids are
  registered and reaped on transport failure

## Process

Open an issue describing the three stacks and the orphan evidence (#9138, #9141, #9530) with the
proposed `register(pid, owner, strategy)` API, then split implementation into registry PR and
per-area migration PRs.
