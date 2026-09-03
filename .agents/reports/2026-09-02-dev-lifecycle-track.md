# Report 2: Development Lifecycle & Tooling Optimization

Date range: Aug 30 - Sep 2, 2026
Branches: `main` (toolchain, preload, test scripts) + `migrate/scripts-to-ts` (84 commits, unmerged)
Upstream baseline: stablyai/orca main

## 1. Context

The memory track (report 1) established that iteration speed and trustworthiness of the loop were
the real bottlenecks on an 8GB M1 MacBook Pro. The same was true one level up: every lifecycle
operation on this fork was slower or riskier than it needed to be. CI scripts were untyped
JavaScript (a bad workflow ref only failed when CI ran it). The preload bundle was a ~4,900-line
monolith where a missing API key type-checked clean and only failed at runtime. The toolchain was
one generation behind (rolldown-vite alias instead of native Vite 8). This track attacked the
lifecycle itself: typecheck everything, guard the contracts, upgrade the toolchain.

## 2. Spotting the problems

- **Untyped script tree.** `config/scripts/` held ~344 files (~64k LoC) of `.mjs`/`.cjs` powering
  CI gates, release builds, benchmarks, and locale pipelines. No typechecking; a rename or
  workflow edit surfaced only as a red CI run minutes later, or worse, never.
- **Dead weight.** 27 microbenchmarks had zero callers but were carried, tested, and linted.
- **Preload monolith.** `src/preload/index.ts` was ~4,900 lines assembling 80 IPC domain keys
  inline. Nothing verified that a channel renamed in main was renamed in preload. A latent bug
  proved the risk: `app.awaitBeforeUnloadCheckpoint` existed in the contract and main-side
  handler but was never attached to the exposed api literal - a real runtime failure hidden by a
  `@ts-expect-error` suppressor.
- **Toolchain lag.** Vite was the `rolldown-vite@7.3.1` alias (upstream still is); Babel-based
  transforms still on the React path; electron-vite 5.
- **Slow locale tooling.** Locale catalogs bootstrapped by scraping Google free endpoints
  (`bootstrap-locale-catalog.mts` + `bootstrap-zh-catalog.mts`) - slow, untyped, fragile.

## 3. Analysis

Prioritization followed the same rule as the memory track: remove the largest trust/speed tax per
unit of risk. Analysis points:

- **Typechecking is the cheapest guard per LoC.** A `tsconfig.scripts.json` (noEmit, Bundler
  resolution, `allowImportingTsExtensions`) plus a 4th parallel typecheck project (`tc:scripts`
  alongside node/cli/web) turns a whole class of CI breakage into a 3-second local failure.
- **Migration must be atomic per batch.** Each batch renames files and ALL importers (including
  `.github/workflows/*.yml` CLI refs) in one commit, so every commit is green.
- **Guards beat discipline.** A monolith gets refactored once; a parity guard keeps it from
  regrowing. `check-ipc-channel-parity.mjs` scrapes the bridge directory and fails lint on
  main/preload channel drift - renames that slip past both typecheck worlds get caught.
- **Node 24 floor enables direct `.ts` entry**, eliminating the `.mts` intermediate dance.
- **Toolchain upgrades pay compounding interest** into the test track (native oxc transforms are
  a prerequisite for the Vitest gains in report 3).

## 4. Solutions implemented

### 4.1 JS -> TS scripts migration (branch `migrate/scripts-to-ts`, tip `c52cdec1`, 84 commits)

| Phase       | Commits                                                                                                                                                                | What                                                                                                                                                                                                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 0     | `edd61b58`, `6eb1ff88`                                                                                                                                                 | Deleted 27 zero-caller microbenches (~6.3k LoC, ~10% of surface, each verified caller-free); `locale-overrides` barrel consolidating 22 locale data files                                                                                                            |
| Phase 1     | `7228920b`                                                                                                                                                             | `config/tsconfig.scripts.json`, `tc:scripts`, parallel 4-project typecheck runner, oxlint `.mts`/`.cts` overrides, `no-floating-promises` scoped to scripts, migration docs                                                                                          |
| Batches 1-7 | `9406f6c1`, `e998a6ad`, `4f25814c`, `56198cc5`, `fb48c90f`, `72277cbf`, `c14096f4`, `7e42f53c`, `8a966fe7`, `181c444f`, `81d743ac`, `f4931d0f`, `e0bdde14`, `c52cdec1` | Atomic renames: locale data (24 files), build/release versioning (13), telemetry (15), vite runners, esbuild bundlers, platform/native build, native-dep `.cjs` loaders, CI-invoked scripts, package.json entry points, locale tests, contract tests (46 test files) |
| Finish      | `c626ec73`, `2895032c`                                                                                                                                                 | Mass `.mts` -> `.ts` rename (299 files); all workflows on Node 24                                                                                                                                                                                                    |

End state on branch: `config/scripts` has 246 `.ts`/`.cts` files; 52 runtime `.mjs`/`.cjs` remain
(validated keepers: `electron-builder.config.cjs`, node-pty patch/loader `.cjs`, live-remote repro
fixtures) - down from ~172 runtime JS files. Payoff already realized: the migration surfaced **5
duplicate object keys silently overwritten at runtime** in locale data, plus 12 narrowing errors
and several `unknown`-refinement bugs. 24 cross-extension `scripts -> src/**` imports now
typecheck end-to-end.

### 4.2 Preload split + parity guard (main)

- `18ef8367` - fixed the latent `awaitBeforeUnloadCheckpoint` bug and typed the api literal,
  deleting the `@ts-expect-error` suppressor.
- `b5e23d8c` + ~25-commit extraction series (pty, app, fs, browser, runtime/ssh, gh, ui,
  notification-sound-state, native-file-drop-listeners...) - `src/preload/index.ts` reduced to
  **246 lines**; **49 bridge modules** under `src/preload/bridge/`, each under the 300-line
  ratchet with no max-lines disables.
- `2b10ecc9` + `054062f6` - `check:ipc-channel-parity` guard, wired into `pnpm lint` and pr.yml;
  channel drift is now a lint failure. CI-gated alongside `check:max-lines-ratchet` (pr.yml:110,
  :134).

### 4.3 Toolchain upgrades (main)

- `10f5b235` - Vite 8.2.2 + electron-vite 6.0.0-beta.1: native oxc transforms replace the
  rolldown-vite alias; main-process externals switched to RegExp form (rolldown native binding
  rejects function predicates); pnpm `@pnpm/exe` spawn fix. Upstream is still on the alias.
- `9b91ed47` - React Compiler wiring, default off (`ORCA_REACT_COMPILER_ENABLED=1`), independent
  for web and desktop renderer; `oxc-transform-react` optional peer.
- `bca12063` - `AgentTerminalPreview` made react-compiler-safe (seeded ref object, render-time
  keyed state), unblocking future memoization.

### 4.4 Locale pipeline (branch-only, `intl-ai` adoption)

`80613308`, `d8edf1604`, `d583df47` on the migration branch: replaced the Google-endpoint
scrapers with a typed OpenRouter-based pipeline (user's own sigilco/intl-ai as core), 7 wrapper
modules in `config/scripts/`: lockfile v2 SHA-1 stale detection, placeholder guard, glossary
injection, post-fill quality judge, dry-run default, zh first (~1,616 leaves, human review
before es/ja/ko). Deletes `bootstrap-locale-catalog` + `bootstrap-zh-catalog` and the Google-era
caches.

### 4.5 Fast-loop scripts (main)

`tc` (4-project parallel typecheck), `test:changed` (vitest related, report 3), `test:orphans`,
`check:ipc-channel-parity`, `check:max-lines-ratchet`, `check:code-quality:changed` (lint the
diff only).

## 5. Computed deltas

| Change                                     | Delta                                                                                                                             |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `tc:scripts` wired into parallel `pnpm tc` | CI-script breakage moves from "red CI minutes later" to "~3s local failure"; 5 real latent bugs found during migration alone      |
| Phase 0 dead-code deletion                 | -6.3k LoC maintained, linted, and tested forever after (~10% of the script tree)                                                  |
| Preload split                              | 4,900 -> 246 lines (95% reduction in monolith size); 49 modules each under 300-line ceiling; 1 latent runtime bug fixed           |
| IPC parity guard                           | channel drift class eliminated (57+ gh: channels covered); would have caught the awaitBeforeUnloadCheckpoint bug class            |
| Vite 8 native oxc                          | prerequisite for all report-3 test-transform gains; build transform path no longer Babel-based                                    |
| intl-ai pipeline                           | replaces endpoint-scraping with cached, lockfile-driven fills; repeated locale syncs go from slow scrape to cache-hit + API delta |

## 6. Edge over upstream

- Upstream runs `rolldown-vite@7.3.1` / electron-vite 5; this fork is on native Vite 8 +
  electron-vite 6 beta with React Compiler wiring ready behind a flag.
- Upstream has **zero** occurrences of `tc:scripts` or `ipc-channel-parity` in package.json -
  both classes of guard are fork-only. Their `config/scripts` remains untyped `.mjs`.
- Upstream preload architecture differs (their `src/preload/index.ts` is already small at this
  ref), but the fork's parity guard (main<->preload channel contract enforcement in lint + CI)
  has no upstream counterpart regardless of file shape.
- intl-ai locale pipeline has no upstream equivalent; upstream still scrapes.

## 7. Caveats / follow-ups

- The migration branch (84 commits) and intl-ai are **not merged to main**; merge is the next
  lifecycle action, ideally before further upstream rebases to avoid compounding conflicts.
- 52 runtime `.mjs`/`.cjs` files remain by design (native loaders, builder config, live repro
  fixtures); documented in `docs/reference/scripts-migration.md` (branch).
- React Compiler stays default-off until a broader safety pass justifies enabling.
