# Report 3: Test Infrastructure Speedup

Date range: Sep 1 20:25 - Sep 2 09:55, 2026 (~13.5h)
Branch: `main` (11 commits)
Full detail: `.agents/reports/2026-09-02-test-infra-speedup.md` (this is the condensed restatement
for the overarching series; read that file for the full upstream comparison and per-commit table)

## 1. Context

With measurement trustworthy (report 1) and the lifecycle guarded (report 2), the remaining
iteration bottleneck was the test loop itself: ~65k tests behind one monolithic Vitest config,
no incremental entry point, no prebundling, happy-dom booted per-file with no pruning, and no
guard that newly added tests run at all. Every verification, including every future upstream
rebase, paid full price.

## 2. Problems, analysis, prioritization

Baseline problems: single flat vitest config with default parallelism; no compile cache; no
project split; ~780 happy-dom docblocks each paying ~200-250ms boot; heavy renderer deps
(react-dom, i18next, xterm, react-router) ESM-transformed per worker per run; env-sensitive tests
whose results depended on the developer's machine; no collection-complete guarantee.

Analyses (verified, not assumed): Vitest 4 project semantics read from installed source (projects
do not inherit root test options or aliases; `extends: true` rejected as implicit); cost
decomposition (per-file env boot vs transform vs collection); empirical A/B for every adopted
change. Four tooling options were researched and rejected with recorded reasons so they are never
re-litigated: SWC swap (oxc already native on Vite 8), global electron/node-pty stubs (633
per-file mocks, unsafe aliasing), `oj` (alpha), rolldown `bundleAnalyzerPlugin` for tests (it is
a build-stage hook, verified empirically).

Prioritized by cost-removed / (effort + risk): worker pinning + compile cache -> project split ->
env determinism -> test:changed + orphan guard -> docblock pruning -> deps.optimizer + telemetry.

## 3. Solutions (11 commits, chronological)

1. `76b7bede` worker pinning (`minWorkers=maxWorkers=cpus-1`, win32 stays 4) + `NODE_COMPILE_CACHE`.
2. `b5cf5bd8` project split: `fast` (shared/relay/cli/scripts, forks+isolated), `main`, `renderer`
   (node env + per-file happy-dom), `e2e-unit`; shared options/aliases spread per project.
3. `3b7d2303` env determinism: git-config pinning for fixtures + code-under-test spawns, shell
   noise scrubbing. Prerequisite for trustworthy numbers.
4. `f62a88a4` resolve dedupe via `sharedResolve`.
5. `df171a51` `test:changed` (`vitest related`, 8GB heap pinned - graph build OOMs at default).
6. `11b18a48` orphan guard (`check-test-project-membership.mjs`) in lint + CI.
7. `eae9bfec` happy-dom docblock pruning: 18 of 33 static candidates converted green, 15 reverted
   after runs showed transitive DOM use (~45% static-grep false-positive rate).
8. `c5d851dc` renderer `deps.optimizer.web.include`: react, react-dom(+client/server), i18next,
   react-i18next, zustand, react-router.
9. `ed2c7c71` AGENTS.md documents the tc-first inner loop.
10. `cba4ed23` `experimental.importDurations` telemetry (on-warn, 100/500ms thresholds) + xterm
    prebundling + adoption policy comment.

Deliberate non-actions: renderer-dom project split rejected (dev loop is file-scoped; only
docblocked files pay happy-dom); fast/main optimizer includes not added (no importDurations hits).

## 4. Computed deltas

| Step | Delta |
|---|---|
| `test:changed` | leaf-change verification ~90s vs ~15min full suite (~10x) |
| deps.optimizer (react/i18n/router/zustand) | warm renderer slice 7.89s -> 6.76s (~14%) |
| xterm added | transform 2.2s -> 1.7s, import 0.5s -> 0.33s, wall ~18% on ~70 xterm-heavy files |
| docblock drops | ~200-250ms x 18 files per renderer run |
| worker pinning + compile cache | enabler for everything; removed oversubscription thrash |

Cumulative: inner dev loop went from "hand-pick tests or eat 15 minutes" to
`pnpm tc` (~3s) + `pnpm test:changed` (~90s worst case); full renderer suite ~14-18% faster;
guards make "silently never runs" a lint failure.

## 5. Edge over upstream (verified Sep 2; upstream 463 commits ahead)

Upstream's config is today what our baseline was: flat config, no projects, no deps.optimizer,
no importDurations, no incremental script, no orphan guard, 837 happy-dom docblocks across 8
monolithic CI shards, rolldown-vite 7. The edge is structural: ~10x cheaper inner loop, materially
cheaper full suite, and a guard system that keeps the project split safe through weekly upstream
merges. Our changes concentrate in files upstream rarely touches, so rebase conflict probability
stays low.

## 6. Caveats

`vitest related` needs the pinned 8GB heap; 767 happy-dom docblocks remain (pruning needs run
verification, not grep); CI still uses upstream's 8-shard shape deliberately (per-project sharding
would diverge the workflow file); `importDurations` is experimental - re-verify on vitest bumps.
