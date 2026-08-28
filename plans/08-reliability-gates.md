# 08: Register resource-lifetime conventions as reliability gates

Status: draft for upstream discussion
Effort: S
Note: open as an issue immediately; other interventions (04, 06) should land against these gates

## Problem

The repo fixes bug classes at one site without recording that the class was fixed. Example:
`grok-session-paths` fixed one unclosed `opendir`, while roughly 36 non-test `opendir` call
sites remain across `src/` (e.g. `src/shared/quick-open-directory-reader.ts`,
`src/shared/quick-open-readdir-walk.ts`, `src/relay/workspace-space-scan.ts`,
`src/shared/node-markdown-document-discovery.ts`). The next contributor has no mechanism to
discover "this class has a convention" and the next fix cannot fail CI when a listed file
regresses.

## Evidence

The repo already has the right machinery:

- `config/reliability-gates.jsonc` (~17,000 lines) tracks issue-to-gate evidence with red/green
  status and `protection` levels (`none` / `partial` / `active`), plus a maturity policy
  (`experimental` / `soak` / `blocking` / `accepted-gap` / `deprecated`) and promotion rules
  (schemaVersion 1, `blockingPromotion` with soak-run and flake minimums).
- `config/scripts/check-reliability-gates.mjs` (~430 lines) validates the file and is wired into
  `pnpm lint` (`check:reliability-gates`, package.json:14).
- `AGENTS.md` documents the conventions.

What is missing is not a framework; it is entries in this file for the resource-lifetime classes.

## Design

Add three gates, each using the existing jsonc schema exactly (id, title, maturity, protection,
owner, layer, surfaces, invariant, oracle, commands, motivatingLinks):

1. `dir-handle-closure`: covers the ~36 `opendir` sites. Invariant: every directory handle is
   closed on all paths, including error paths. Oracle: the closure-checking tests for each
   listed file. Starts at `partial` covering the already-fixed sites, flips to `active` as the
   migration PR lands coverage for the remaining sites.
2. `child-process-tree-termination`: covers spawn/kill sites. Invariant: spawned child processes
   are terminated as a tree on session teardown, not just the direct child. Oracle: the
   process-tree termination tests (the repo already has `process-tree-termination` primitives to
   build oracles on).
3. `bounded-retention`: covers keyed registries and buffer caps. Invariant: every unbounded-growth
   candidate (keyed registries, retained buffers, tail accumulators) uses a bounded primitive
   (`bounded-map.ts` / `bounded-buffer.ts` per doc 06) or documents an explicit exemption.
   Oracle: per-module retention tests. Starts `partial` with the sites doc 04 and doc 06 touch.

Each gate lists a file allowlist. The check script fails CI if a listed file regresses (loses its
guarding test command or reintroduces the unguarded pattern).

## YAGNI

- No new framework. Reuse the existing jsonc schema, maturity levels, and check script verbatim.
  The change is data (gate entries) plus their oracle test commands, not code.

## Measurement

- Gate status flips are the metric: `none` to `partial` on issue open, `partial` to `active` when
  each migration PR lands.
- Regression = a red gate in CI, which is the point: the class stays fixed, not just the site.

## Effort

S. Adding three well-scoped gate entries with existing test commands is hours, not days. Open it
as an issue immediately: doc 04 (SessionMemoryBudget) and doc 06 (buffer consolidation) should
flip `bounded-retention` to `active` as they land, so the gates issue must exist first.

## Anchors

- Schema: `config/reliability-gates.jsonc` (schemaVersion 1 gate objects with
  `protection`, `commands`, `invariant`, `oracle`, `motivatingLinks`).
- Self-test: `config/scripts/check-reliability-gates.mjs` validation behavior (run
  `pnpm run check:reliability-gates` locally; it is part of `pnpm lint`).
- No schema-level test files observed; if maintainers have hidden contract tests for the jsonc
  shape, they should be linked here before the first gate PR.
