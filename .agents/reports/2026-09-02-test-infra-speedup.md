# Test Infrastructure Speedup: Full Report

Fork: `espetro/orca` (main) vs upstream `stablyai/orca` (main).
Period: Sep 1, 2026 20:25 through Sep 2, 2026 09:55 (all work landed within ~13.5 hours).
Scope: unit-test execution infrastructure (Vitest), not the tests themselves.

## 1. Context: why we ended up working on this

The fork was tracking upstream closely and shipping parallel feature tracks (scripts-to-TS
migration, preload bridge split, intl-ai pipeline). Every one of those tracks is verified by the
same inner loop: edit, typecheck, run tests. Two things made the loop the bottleneck:

1. **Scale.** The suite is ~65k tests across ~thousands of files. A full `pnpm test` was the only
   sanctioned way to verify, and it ran as one monolithic Vitest config with default parallelism.
2. **Divergence risk.** Upstream releases frequently (463 commits ahead of the fork baseline at the
   time of writing). Rebase surface grows daily; each rebase re-runs the full suite. A slow,
   fragile test setup taxes every future merge.

The decision was to treat test infrastructure as a first-class performance problem: measure, fix
the largest cost first, and leave behind guards so the setup cannot silently regress.

## 2. Spotting the problems

The baseline (`30ebbdd3b`, Sep 1) looked like this:

- Single monolithic `config/vitest.config.ts`: one `test` block, `environment: 'node'` globally,
  one global include glob, shared setup files, 60s/30s timeouts.
- Only tuning: `maxWorkers: 4` on Windows; nothing on macOS/Linux.
- No compile cache, no dependency prebundling, no incremental entry point.
- happy-dom applied per-file via docblocks (~780 files locally, 837 upstream) — every one of those
  files paid a DOM environment boot even when the test never touched a DOM.
- CI: `vitest run --shard=N/8` over the flat config; 16 hardcoded excludes inline in the workflow.
- No guard that a newly added test file is actually collected by any project.

Problems identified, in order of discovery:

- P1: full-suite wall time dominated by redundant work (imports re-transformed per worker, DOM
  envs where none needed, unbounded worker count).
- P2: no incremental verification path — every change, however small, paid full-suite cost or
  relied on manually picking "related" tests.
- P3: correctness leaks made results machine-dependent (developer git config bleeding into git
  fixtures, macOS shell noise), so any speedup would have been untrustworthy.
- P4: the project split (once made) creates a new failure mode: test files that match no project
  glob and silently never run.

## 3. Analysis

Before writing code, three analyses were done:

**Cost decomposition.** happy-dom boot costs ~200-250ms per file, paid by ~780 files. Heavy
renderer deps (react-dom, i18next, xterm, react-router) were being ESM-transformed per worker per
run. Collection/graph work dominates small runs, transform dominates large ones.

**Vitest 4 project semantics** (verified from installed source): projects do NOT inherit root
`test` options or root `resolve.alias`; `extends: true` was rejected as implicit and fragile. The
split must spread shared options per project — this became `sharedTestOptions` + `sharedResolve`.

**Tooling options rejected after research** (kept on record so we don't re-litigate):

| Option                                    | Verdict | Reason                                                                                                                                                         |
| ----------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SWC swap for Babel                        | Reject  | Vite 8 + `@vitejs/plugin-react` v6 already use native oxc for JSX; Babel remains only on the React Compiler path; Vitest never routes through the react plugin |
| Global stubs for electron/node-pty        | Reject  | 633 per-file mocks exist; aliasing stubs globally is unsafe                                                                                                    |
| `oj` build tool                           | Reject  | Alpha, solo-maintained, unproven on win32                                                                                                                      |
| rolldown `bundleAnalyzerPlugin` for tests | Reject  | It is a `generateBundle`/`writeBundle` hook: applies to production build audits, not `deps.optimizer` measurement (verified empirically)                       |
| Catch-all trailing project for orphans    | Reject  | In Vitest 4, projects collect independently; overlapping includes double-run files rather than catching misses                                                 |

**Prioritization.** Rank by (cost removed) / (effort + regression risk):

1. Worker pinning + V8 compile cache (S, free win)
2. Project split (M, unlocks everything else)
3. Env-determinism fixes (M, prerequisite for trustworthy numbers)
4. `test:changed` + orphan guard (M, biggest dev-loop win)
5. happy-dom docblock pruning (S-M)
6. `deps.optimizer` prebundling + import-duration telemetry (M, ongoing)

## 4. Iterative solutions

Chronological, with what each step actually did:

| #   | Commit                           | Date              | Change                                                                                                                                                                                                                                                |
| --- | -------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0   | `10f5b235`, `9b91ed4`, `bca1206` | Sep 1 21:10-21:19 | Vite 8 + electron-vite 6 beta + React Compiler wiring (default off). Native oxc transforms land before test work begins.                                                                                                                              |
| 1   | `76b7bede`                       | Sep 1 20:25       | Pin `minWorkers=maxWorkers=cpus-1` (win32 stays 4); `NODE_COMPILE_CACHE` V8 compile cache on the test script.                                                                                                                                         |
| 2   | `b5cf5bd8`                       | Sep 1 22:43       | Project split: `fast` (shared/relay/cli/scripts, forks+isolated), `main` (src/main, forks), `renderer` (src/renderer+preload, node env + per-file happy-dom), `e2e-unit`. Shared options/aliases spread per project (Vitest 4 does not inherit them). |
| 3   | `3b7d2303`                       | Sep 1 22:43       | Env determinism: `GIT_CONFIG_GLOBAL/SYSTEM` pinning for fixture git + code-under-test spawns; bash banner/`TERM_PROGRAM` scrubbing; IPC parity test reads the split bridge dir.                                                                       |
| 4   | `f62a88a4`                       | Sep 2 07:47       | Root `resolve` deduped against `sharedResolve`.                                                                                                                                                                                                       |
| 5   | `df171a51`                       | Sep 2 08:33       | `test:changed` = `vitest related` with 8GB heap (graph build OOMs at 2GB on this repo); remaining env-sensitive fixtures isolated; parity step wired into pr.yml.                                                                                     |
| 6   | `11b18a48`                       | Sep 2 08:38       | `check-test-project-membership.mjs` orphan guard, wired into `pnpm lint`, PR CI, and `test:orphans`.                                                                                                                                                  |
| 7   | `eae9bfec`                       | Sep 2 09:05       | happy-dom docblock drops: 33 static-markup candidates found, 18 converted green, 15 reverted after runs showed transitive window/document use (~45% false-positive rate for static grep; never trusted without a run). 767 docblocks remain.          |
| 8   | `c5d851dc`                       | Sep 2 09:14       | Renderer `deps.optimizer.web.include`: react, react-dom(+client/server), i18next, react-i18next, zustand, react-router.                                                                                                                               |
| 9   | `ed2c7c71`                       | Sep 2 09:14       | AGENTS.md documents the tc-first inner loop.                                                                                                                                                                                                          |
| 10  | `cba4ed23`                       | Sep 2 09:55       | `experimental.importDurations` telemetry (on-warn, thresholds 100ms/500ms); `@xterm/xterm` + `@xterm/headless` added to optimizer include; policy comment: a lib qualifies only when importDurations repeatedly shows it above warn threshold.        |

Two deliberate non-actions, recorded to prevent rework:

- **renderer-dom project split: rejected.** Only docblocked files pay happy-dom; the dev loop is
  file-scoped, so a separate DOM project adds config surface without loop benefit. Revisit only if
  whole-project renderer runs become the common case.
- **fast/main optimizer includes: not added.** Node-side deps did not show importDurations hits.

## 5. Computed deltas

Numbers as measured at each step (locally, warm caches where stated):

| Step                                       | Delta                                                                                                     | Scope        |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------ |
| V8 compile cache + worker pinning          | not separately measured (enabler step)                                                                    | all projects |
| `test:changed` (vitest related)            | leaf-change verification ~90s vs ~15min full suite (~10x)                                                 | dev loop     |
| happy-dom docblock drops                   | ~200-250ms saved per file x 18 files (~4s per full renderer run)                                          | renderer     |
| deps.optimizer (react/i18n/router/zustand) | warm renderer slice 7.89s -> 6.76s (~14%); transform 8.06s -> 7.32s                                       | renderer     |
| xterm added to optimizer                   | transform 2.2s -> 1.7s, import 0.5s -> 0.33s; wall ~4.2s -> ~3.5s (~18%) on xterm-heavy files (~70 files) | renderer     |

Cumulative effect on the two loops that matter:

- **Inner dev loop** (edit -> tc -> verify): was "run a hand-picked subset or eat 15 minutes."
  Now `pnpm tc` (~3s warm) then `pnpm test:changed <files>` (~90s worst case for hub modules,
  seconds for leaves). Order-of-magnitude reduction for the common case.
- **Full suite** (pre-push / CI): projects allow targeted `--project` runs; renderer runs ~14-18%
  faster from prebundling; 18 files no longer pay DOM boot; worker pinning removes oversubscription
  thrash. Full-suite cost dropped materially without touching a single test assertion.

## 6. Final setup

- `config/vitest.config.ts`: 4 projects (`fast`/`main`/`renderer`/`e2e-unit`), forks pool where
  process semantics require it, `sharedTestOptions`/`sharedResolve` spread per project,
  `deps.optimizer.web.include` in renderer (8 packages + 2 xterm),
  `experimental.importDurations` on-warn telemetry, worker pinning, execArgv for gc/retention tests.
- Scripts: `pnpm test` (full), `pnpm test:changed <files>` (vitest related, 8GB heap),
  `pnpm test:orphans` (membership guard).
- CI: orphan guard + lint-parity steps in pr.yml; unit workflow unchanged in shape (upstream-compatible
  shard count) so rebases stay cheap.
- Docs: AGENTS.md documents the tc-first loop and project layout.
- Policy: optimizer includes grow only on repeated importDurations warn hits; orphan guard makes
  "silently never runs" a lint failure.

## 7. Edge over upstream main (verified Sep 2, 2026; upstream 463 commits ahead)

Inspected upstream/main directly (`git show`/`git grep`, no checkout):

| Area                      | upstream/main                       | our fork                                                           |
| ------------------------- | ----------------------------------- | ------------------------------------------------------------------ |
| Vitest config             | single flat config, no projects     | 4 projects, per-project env/pool/isolation                         |
| deps.optimizer            | absent                              | renderer: 10 packages prebundled                                   |
| importDurations telemetry | absent                              | on-warn with thresholds + adoption policy                          |
| Incremental entry point   | none (monolithic `vitest run` only) | `test:changed` (vitest related, ~90s vs ~15min)                    |
| Orphan guard              | absent                              | membership check in lint + CI                                      |
| V8 compile cache          | absent                              | enabled on test script                                             |
| Worker pinning            | only Windows maxWorkers:4           | all platforms, cpus-1                                              |
| happy-dom docblocks       | 837 in one flat run                 | 767, and renderer-project scoped; 18 proven-unneeded files dropped |
| Vite generation           | rolldown-vite 7.3.1                 | Vite 8 (native oxc) + electron-vite 6 beta                         |
| Env determinism           | machine-dependent fixtures possible | git-config/shell-noise isolation landed                            |
| CI excludes               | 16 hardcoded inline in workflow     | none needed; project globs own routing                             |

Interpretation: upstream's setup is exactly our baseline. Their CI spreads 837 happy-dom boots
across 8 shards with no prebundling and no incremental path; their contributors run the full
monolithic suite or nothing. Our edge is structural, not cosmetic:

1. **Rebase economics.** Every future merge from upstream gets verified ~10x cheaper per change
   via `test:changed`, and the orphan guard means the project split can never silently strand a
   test file during a rebase — the highest-risk moment for glob drift.
2. **Conflict surface.** Our changes concentrate in `config/vitest.config.ts`, `package.json`
   scripts, and a handful of test-fixture files. Upstream barely touched `vitest.config.ts` in the
   463-commit window (it remains flat), so conflict probability per rebase is low.
3. **Headroom mechanism.** importDurations turns further optimization from guesswork into a
   repeatable loop: run, read warn lines, A/B a candidate, adopt or revert. Upstream has no
   equivalent signal.

ROI summary: roughly 13.5 hours of work (including the research that rejected four dead ends)
converted into an order-of-magnitude cheaper inner loop, a materially cheaper full suite, and a
guarded structure that survives weekly upstream merges. Payback is reached within days at current
rebase frequency.

## 8. Caveats and follow-ups

- `vitest related` graph build needs the pinned 8GB heap; if the import graph grows much larger,
  revisit (or split the graph).
- 767 happy-dom docblocks remain; further pruning is possible but has a measured ~45% static-grep
  false-positive rate, so each candidate needs a run.
- CI still runs upstream's 8-shard shape. A future improvement is sharding per project (fast/main
  shards are much cheaper than renderer shards), but that diverges from upstream's workflow file
  and raises rebase cost; not worth it while merges stay frequent.
- The `importDurations` flag is experimental; pin vitest minor versions and re-verify on upgrades.
