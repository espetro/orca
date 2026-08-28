# Memory-reduction interventions for stablyai/orca: index

Status: plan index. Each doc is a standalone design draft for upstream maintainers.
Working fork: https://github.com/espetro/orca (branch per intervention, PRs to stablyai/orca).

## Context

Steady-state runtime footprint is ~400-600MB against ~120MB of actual session content.
The gap is retained structures that are each individually bounded but never bounded in
aggregate, plus pollers and teardown paths that never got migrated onto the primitives the
repo already ships. Motivating reports:

- #12728: orca-terminal-daemon 300-400MB private commit per process, never released
- #15241: renderer to 3.4GB RSS from unbounded terminal error accumulation (fix #15306 still unmerged)
- #16905: memory collector + identity probes still spawn powershell.exe per ~2s poll
- #16211: 16GB Windows host, ~40GB committed by agents, page thrashing; diagnostics report working set only
- #9138: stale daemon generations never reaped (reviewed fix design already in thread)
- #9530, #9141: orphaned agent trees and computer-use helpers survive their owners

## Meta-finding

The repo already has the right primitives: `process-tree-termination`, `run-process`,
`bounded-map`, `process-table-snapshot`, ratchet scripts, and repo-local oxlint plugins.
Adoption is incomplete and there are no resource-lifetime guardrails, so the same classes of
problems are re-fixed point by point (grok-session-paths fixed one opendir site; five similar
sites remained; AGENTS.md even documents "never fork powershell.exe" while the memory
collector still does). Doc 08 closes that loop with gates; the other docs raise adoption.

## Doc table

| Doc | Title | What | Effort | PR strategy | Module | Issues |
| --- | --- | --- | --- | --- | --- | --- |
| 01 | fs-opendir-scope | shared withDir/listDirSafe + oxlint import rule; migrate 11 opendir sites | S | PR now (2 PRs: helper+migration, lint rule) | shared, relay | #12895 |
| 02 | process-supervisor | ProcessRegistry routing kills to the 3 existing termination stacks + ratchet | M | issue first, then PR | main, shared | #9530, #9138, #9141 |
| 03 | tab-scoped-cleanup-registry | renderer TabClosed event + registerTabScopedCleanup + lint rule | M | issue first, then PR | renderer | #15241 |
| 04 | session-memory-budget | one aggregate budget at PTY ingress + checkpoint enqueue | M | issue first | main/daemon | #16211, #11218 |
| 05 | session-residency-dehydrate | Residency state machine; dehydrate idle detached sessions via existing disposeEmulator/rehydrate paths | M | PR after issue ping on #12728 | main/daemon | #12728, #16211 |
| 06 | bounded-buffer-consolidation | consolidate ~10 hand-rolled buffers onto bounded-map + BoundedBuffer | M | series of small PRs | shared, renderer | hygiene |
| 07 | process-info-service | native collector migration + TTL snapshot cache + PressureMonitor (3 PRs) | S, S-M, M | PR phases 1-2 now | memory, windows | #16905, #16211 |
| 08 | reliability-gates | register dir-handle / process-tree / bounded-retention gates in reliability-gates.jsonc | S | issue + PR immediately | config | meta |

## Recommended sequencing

1. Doc 08 issue + PR immediately (S; all other PRs flip its gates to active).
2. Doc 01 PRs (S).
3. Doc 07 phases 1 and 2 as PRs (S; explicitly requested in #16905).
4. Doc 05 after pinging nwparker on #12728 (avoid duplicating in-flight work; see #16211 precedent where he merged his own #16591 for a root cause an external found first).
5. Docs 02 and 03 as issues first, PRs after maintainer alignment.
6. Doc 06 hygiene series interleaved when review bandwidth is idle.

## Contribution strategy

- S tasks: PR directly, design doc linked in the PR description.
- M tasks: issue first with the design doc linked, PR only after maintainer alignment.
- Repo norms (from CONTRIBUTING.md + PR template, mandatory): linked issue ("there should
  ALWAYS be one. Fixes #"), ELI5 paragraph, regression tests that would catch vacuous
  passes, cross-platform/SSH/folder-workspace considerations, AI agent review summary,
  conventional-commit title (`perf(scope):` / `fix(scope):`), checks: pnpm lint, tc, test, build.
- One logical change per PR. Conventional commits. No co-authors.
- Include X handle in PR template: they shout out contributors on @orca_build.

## Maintainer contact (verified)

| GitHub | Name | Role | X | Notes |
| --- | --- | --- | --- | --- |
| nwparker | Neil Parker | Co-founder/CTO; owns relay/SSH/PTY/terminal/session | @nwparker_ | Primary reviewer for all our targets; neil@stably.ai; invites contributor calls |
| AmethystLiang | Jinjing Liang | CEO; i18n/editor/UI; triaged #15241 | @JinjingLiang | Amplification channel, not code review |
| Jinwoo-H | Jinwoo Hong | Releases/CI/native builds | @jinwoohong_ | |
| brennanb2025 | Brennan Benson | i18n/localization | @brennankb5 | Only CODEOWNERS entry |
| tmchow | Trevin Chow | Product leader/advisor | @trevin (trev.in) | Founder circle |
| (company) | | | @orca_build | Merge shoutouts; Discord: https://discord.gg/fzjDKHxv8Q |

Engagement reality check: memory-family issues linger with little triage (#12728 and #16905
have zero maintainer replies) and external memory PRs sat 4+ days with no human review
(#16217/#16219/#16220). nwparker sometimes merges his own fix for a bug an external found
(#16591 vs #16214). So: comment root-cause analysis on the issue and ask whether a fix is
in flight BEFORE writing the PR; keep PRs small and independently mergeable; backchannel
via X DM or neil@stably.ai if a PR stalls.

## Patterns

- `await using` is reserved for resource teardown (dir handles, locks, connections), never for
  task supervision. TS 7 supports `using` / `await using`; verified via compiled probe.
- Concurrency orchestration stays native: AbortController + `Promise.all` fail-fast. No custom
  TaskGroup or structured-concurrency framework, no new dependencies (p-limit, p-map).
- Renderer cleanup builds on the existing `DisposableStore` convention with `Symbol.dispose`,
  not a parallel disposal mechanism or `FinalizationRegistry`.

## Measurement principles

- SMART goals: each doc names a metric, a direction, and where it is sampled.
- Each PR ships a before/after metric (daemon private bytes, renderer RSS, powershell spawns
  per minute, opendir sites with guaranteed close, gate status), even for hygiene work.
- Module-local tests only; anchors are each migrated module's own `*.test.ts`, plus the
  repo's bench pattern (`src/main/workspace-snapshot-pruning.bench.test.ts`) where one fits.
- Every doc carries a mandatory YAGNI section: what we deliberately are not doing in v1.
- Guardrail-first where cheap: a PR that lands a shared primitive plus its lint rule or
  ratchet cannot regress silently.
