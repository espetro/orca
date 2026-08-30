# 06: Bounded buffer consolidation onto bounded-map.ts plus one BoundedBuffer sibling

Status: draft for upstream discussion
Effort: M (several small PRs)
Framing: hygiene, not leak hunting

## Problem

The repo already ships a good shared primitive: `src/shared/bounded-map.ts`, a count- and
byte-bounded insertion-ordered LRU map with `maxEntries`, `maxBytes`, `sizeOf`, `maxEntryBytes`
and `onEvict`. It documents the exact contract ("Map + entry counter + retained-byte ledger +
evict-oldest", fail-closed on unmeasurable weights, onEvict fires only on capacity eviction).

Around ten other modules hand-roll cousins of the same pattern, each with its own constants,
ledger logic, and drift:

| Module | Hand-rolled concern |
| --- | --- |
| `src/shared/growing-byte-buffer.ts` | byte-bounded grow/trim |
| `src/shared/ws-outbound-backpressure-queue.ts` | bounded outbound queue |
| `src/shared/relay-frame-buffer.ts` | bounded frame retention |
| `src/shared/pty-retained-string-memory.ts` | retained string ledger |
| `src/shared/string-chunk-compaction.ts` | chunk compaction with size accounting |
| `src/shared/terminal-partial-escape-tail.ts` | bounded tail retention |
| `src/shared/check-job-log-tail-slice.ts` | bounded log tail |
| `src/shared/osc-title-scan-tail.ts` | bounded escape-sequence tail |
| `src/renderer/src/components/terminal-pane/pty-pre-handler-buffer.ts` | bounded pre-handler buffer |
| `src/renderer/src/components/activity/activity-portal-churn-budget.ts` | churn budget |

Separately, budget constants are scattered across module-local files
(`src/shared/windows-command-line-budget.ts`, `src/shared/git-diff-transport-budget.ts`,
`src/shared/remote-rpc-content-budget.ts`, `src/shared/workspace-space-scan-budget.ts`,
`src/shared/quick-open-transport-budget.ts`), and the `slice(-N)` retention idiom appears in
~115 non-test files under `src/` (~149 including tests). Each site re-implements the same
"keep the tail, bound it" decision with no shared, tested implementation.

Per-module drift is not hypothetical. #15241 (error accumulation leak) reinvented an uncapped
accumulator next to a repo that already had a bounded-map; the fix was point, not systemic.

## Evidence

- `src/shared/bounded-map.ts:1-27` documents the shared contract; the hand-rolled cousins above
  each re-encode a subset of it.
- #15241: a new accumulator shipped uncapped because there was no default "reach for the bounded
  primitive" habit.
- `pnpm audit:dead-code` (`config/knip.json`, package.json:19) is already configured, so dead
  cousins will be flagged as they become unused; no new tooling needed.
- `config/oxlint-plugins/quadratic-buffer-concat.mjs` is an existing repo-local oxlint plugin and
  a ready template for a lint-level guard.

## Design

1. Add `src/shared/bounded-buffer.ts`: a `BoundedBuffer<T>` sibling of `BoundedMap` for
   single-queue (non-keyed) retention: `maxEntries`, `maxBytes`, `sizeOf`, `onEvict`,
   append/trim semantics mirroring bounded-map's fail-closed and evict-only-on-capacity rules.
2. Migrate the three lowest-risk modules first:
   - `src/shared/osc-title-scan-tail.ts`
   - `src/shared/check-job-log-tail-slice.ts`
   - `src/shared/terminal-partial-escape-tail.ts`
   Each migration is its own PR, one logical change, existing module tests prove no behavior
   change.
3. As cousins are removed, knip (`audit:dead-code`) confirms the dead exports disappear. Nothing
   new to build.
4. Stretch (separate PR, only if the first three land cleanly): an oxlint rule modeled on
   `quadratic-buffer-concat.mjs` flagging raw `slice(-N)` retention outside the shared module.

## YAGNI

- Do NOT migrate `src/main/daemon/daemon-stream-data-batcher.ts` or
  `src/shared/relay-frame-buffer.ts` in v1. Both carry incident-driven behavior
  (keep-tail-drop, backpressure) that predates and differs from the generic contract; forcing
  them onto the shared primitive risks regressing fixes.
- No unified "budget constants registry" in v1; consolidation is about code, not centralizing
  every numeric constant.
- No renderer/main cross-boundary shared wrapper yet; the primitive is generic, adoption is
  per-module.

## Measurement

- LOC and module-count reduction: each migrated module should shed its hand-rolled ledger
  (target: net negative LOC per PR including tests).
- knip output: removed modules no longer appear; no new dead exports introduced.
- Behavior: no behavior change, proven per-module by each module's existing `*.test.ts`
  (`osc-title-scan-tail` tests, `check-job-log-tail-slice` tests, `terminal-partial-escape-tail`
  tests), module-local only.

## Effort

M total, but split into several small PRs: (1) add bounded-buffer.ts, (2-4) one migration each,
(5, stretch) oxlint rule. S-sized per PR, which is the point: the consolidation should be easy to
review and easy to stop.
