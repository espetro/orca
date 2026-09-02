# Overarching Report: Feedback-Loop Optimization Program

Fork: `espetro/orca` vs upstream `stablyai/orca`
Window: Aug 29 - Sep 2, 2026 (125 fork commits since Aug 27; ~66 local)
Program: three sequential tracks, one shared premise.

Companion per-track reports:
- `.agents/reports/2026-09-02-memory-harness-track.md`
- `.agents/reports/2026-09-02-dev-lifecycle-track.md`
- `.agents/reports/2026-09-02-test-infra-track.md` (full: `2026-09-02-test-infra-speedup.md`)

## 1. The premise, and how it changed shape

The starting question was concrete: why does a baseline Orca instance read ~500MB RSS, and can we
tune it down? The machine available to answer it is an 8GB M1 MacBook Pro. Within the first
measurement attempts the real problem revealed itself: **the loop used to iterate was slower and
noisier than the thing being optimized.** Benchmarks leaked their own Electron processes, a
+19MB "delta" on identical binaries was indistinguishable from signal, ad-hoc `ps` reads were the
only instrumentation, and every verification of a candidate change meant either hand-picking
tests or eating a 15-minute full suite on an untyped, unguarded codebase.

The decision, which turned out to be correct, was to invert the program: optimize the harness and
lifecycle first, so that when RSS interventions run, their results are fast to obtain and
trustworthy. The original RSS goal is the program's outstanding final phase, now properly
instrumented for it.

## 2. The three tracks (in execution order)

### Track A - Memory measurement harness & host-noise elimination (Aug 29 - Sep 1)
Branch `exp/mem-observability` + `exp/mem-autoresearch` (unmerged)

Built the measurement instrument: in-app `ResourceRecorder` (tick loop, ring buffer, dump)
exposed over an e2e IPC bridge; interleaved 3-run A/B harness with mandatory 120s settle,
discarded warmup run, per-run JSON artifacts, IQR-disjoint verdicts with 8 deviance flags; null-
test validation committed as artifacts; playbook documenting metric semantics and confounds.
Hardened the harness itself (process-tree group kill, pre-run `reapLeftovers`, free-port picking,
signal-time reaping) after discovering it leaked ~45 Electron orphans (~225MB) per session.
Three host-noise deep-dives produced upstream-quality findings: the daemon terminal-session leak
(~950MB, upstream #13764, we hold a first-filer fix design), the harness orphans (unfiled
upstream; fixed in-track), and long-run renderer growth (465MB after 1d4h; mapped to upstream
#15241/#15306 and #8652 with concrete fix paths). A coverage study sized the prize: ~25-35% of
recent upstream issue load is addressable by resource-usage work; verdict "worth the investment".

Measured outcome: noise floor protocol went from unknown to characterized (+19.17 -> clean -15.38
null run; ~38MB per-run median half-spread as the stated resolution limit; warmup outlier
eliminated). Measurement went from ad-hoc ps reads to a validated ~16-18min A/B iteration.

### Track B - Development lifecycle & tooling (Aug 30 - Sep 1)
Branch `main` (toolchain, preload, guards) + `migrate/scripts-to-ts` (84 commits, unmerged)

Migrated the CI/script tree from untyped JS to typechecked TS: Phase 0 deleted 27 zero-caller
microbenches (~6.3k LoC); Phase 1 wired `tc:scripts` into the parallel 4-project typecheck; seven
atomic batches plus a 299-file `.mts`->`.ts` consolidation left `config/scripts` at 246 typed
files with 52 validated-by-design JS keepers. The migration immediately paid for itself by
surfacing 5 duplicate locale-data keys silently overwritten at runtime, plus ~17 other latent
type errors. Split the ~4,900-line preload monolith into 49 bridge modules under a 300-line
ratchet (index.ts now 246 lines), fixing one latent runtime bug (`awaitBeforeUnloadCheckpoint`
defined but never exposed) in the process, and added an IPC channel-parity guard to lint + CI so
the monolith cannot regrow undetected. Upgraded the toolchain to native Vite 8.2.2 +
electron-vite 6 beta (dropping the rolldown-vite alias upstream still uses) with React Compiler
wiring default-off. Replaced Google-endpoint locale scraping with the intl-ai/OpenRouter pipeline
(branch-only).

### Track C - Test infrastructure (Sep 1 - Sep 2, ~13.5h)
Branch `main`, 11 commits

Split the monolithic Vitest config into 4 projects with correct pool/isolation semantics (read
from installed Vitest 4 source, not guessed), pinned workers, enabled the V8 compile cache,
landed env-determinism fixes so results stop depending on the developer's machine, added
`test:changed` (vitest related) as the incremental entry point and an orphan guard so no test
file can silently match no project, pruned 18 provably-unneeded happy-dom docblocks, prebundled
10 renderer dependencies guided by A/B measurement, and enabled `experimental.importDurations`
telemetry as the deterministic discovery loop for future candidates. Four seductive options were
researched and rejected with recorded reasons (SWC, global stubs, oj, bundleAnalyzerPlugin).

Measured outcome: dev loop ~10x cheaper (~90s leaf verification vs ~15min full suite); renderer
runs 14-18% faster from prebundling; zero orphans; guards in CI.

## 3. Cumulative delta

### Feedback loop, end to end (the program's actual product)

| Operation | Before (Aug 29) | After (Sep 2) |
|---|---|---|
| Verify a one-file change | hand-pick tests or ~15min full suite | `pnpm tc` ~3s + `test:changed` ~90s worst case (seconds for leaves) |
| Typecheck everything incl. scripts | scripts untypechecked | 4-project parallel `tc` (~3s warm) |
| Trust a memory A/B | impossible (noise > signal, +19MB floor on identical binaries) | validated 3-run A/B, ~16-18min, stated 38MB resolution, deviance flags |
| Find a slow dependency | guesswork | importDurations warn lines -> A/B -> adopt/revert |
| Break main<->preload IPC contract | silent, found at runtime | lint failure before push |
| Add a test file that matches no project | silently never runs | lint/CI failure |
| Merge upstream (463 commits ahead) | each rebase re-paid full test cost, no incremental path | rebase verified ~10x cheaper; guards catch glob drift |
| Iterate on locale catalogs | slow endpoint scraping | cached OpenRouter fills with stale detection (branch) |
| CI script breakage | discovered by red CI | typecheck failure in ~3s locally |

### Composite effect

Rough ordering: the incremental test entry point is the single largest win (~10x on the most
frequent operation). The harness work is the largest trust win (it converts "maybe" into
"improved/regressed/inconclusive with flags"). The lifecycle work is the largest latent-bug win
(6+ real bugs found by types and guards, including one shipped-user-facing-path bug). The three
compound: Track C's transforms were only possible because Track B landed Vite 8; Track A's
protocol fixes are why Track C's A/B numbers could be believed; Tracks B+C's guards are why all
of it survives weekly upstream merges.

## 4. ROI, ranked, data-backed

Ranked by (frequency x cost removed) / effort, using measured numbers:

| Rank | Action | Cost | Payback evidence |
|---|---|---|---|
| 1 | `test:changed` incremental entry point (Track C) | ~2h | ~90s vs ~15min per verification; used on every single change; payback in <1 day of iteration |
| 2 | Bench harness v2 + hardening (Track A) | ~1.5 days | Without it, zero RSS conclusions were possible; every future intervention depends on it; also stopped a live ~225MB/session host leak |
| 3 | Vitest project split + worker pinning + compile cache (Track C) | ~4h | Enables targeted runs, removed oversubscription; prerequisite for rank 1 |
| 4 | `tc:scripts` + JS->TS migration (Track B) | ~3-4 days | Found 5 silent data-corruption bugs + ~17 latent errors during migration itself; converts CI breakage from minutes-late to 3s-local |
| 5 | Preload split + parity guard (Track B) | ~1.5 days | Fixed 1 shipped latent bug; guard cost ~4h prevents the whole regression class permanently |
| 6 | deps.optimizer + xterm + importDurations (Track C) | ~3h | 14-18% renderer runs; telemetry makes future candidates cheap to evaluate |
| 7 | Vite 8 + electron-vite 6 + React Compiler wiring (Track B) | ~half day | Unblocked Track C entirely; parity with (actually ahead of) upstream toolchain |
| 8 | Env-determinism fixes + orphan guard (Tracks B/C) | ~half day | Correctness of every other number; tiny cost |
| 9 | intl-ai locale pipeline (Track B) | ~1 day (branch) | Slow scrape -> cached fills; payback each locale sync |
| 10 | happy-dom docblock pruning (Track C) | ~2h | Smallest, bounded; ~4s/renderer run; stops here by design |

The pattern the ranking shows: **measurement and entry points first, guards second, micro-
optimizations last** - which is the order execution actually followed.

## 5. Edge over stablyai/orca

Verified against upstream main (463 commits ahead) during the tracks:

- Test infra: upstream is at our Track C baseline (flat config, no projects/optimizer/telemetry/
  incremental script/orphan guard, 837 happy-dom docblocks in 8 monolithic shards).
- Toolchain: upstream on `rolldown-vite@7.3.1` alias; fork on native Vite 8.2.2 with React
  Compiler wiring staged.
- Scripts: upstream has zero `tc:scripts` / `ipc-channel-parity` equivalents; fork's script tree
  is typed and guarded.
- Memory: upstream has no committed benchmark protocol, playbook, or null-test artifacts; fork
  has a validated A/B instrument plus three upstream-quality bug investigations (including a
  first-filer fix design for #13764).
- Upstream-relative bug knowledge: fork can land #15306 verbatim (bounded terminal-error
  accumulation) as a cheap first RSS win with the measurement to prove it.

The edge is structural rather than cosmetic: a faster loop (10x inner verification), a trustworthy
loop (statistically honest benchmarks), and a guarded loop (regression classes converted to lint
failures). It concentrates in files upstream rarely touches, keeping rebases cheap.

## 6. What remains (the original goal, now unblocked)

1. **Merge the unmerged branches** (`exp/mem-autoresearch`, `migrate/scripts-to-ts` incl. intl-ai)
   to main before the next upstream rebase compounds conflicts.
2. **Run the actual RSS program** the premise asked for, with candidates already identified and
   priced: land #15306 verbatim; SSH-parking gap fix (#8652 option A); V8 flag experiments
   (`--max-semi-space-size`, -36MB precedent); sqlite `mmap_size=0`/WAL tuning; complete the
   verdicts for the built-but-unmeasured bisect apps (F1/F2/F3).
3. **Raise instrument resolution**: 5+ runs and `/usr/bin/footprint -p` as primary metric
   (ps keyword is dead on modern macOS) to resolve <38MB deltas.
4. Optionally: upstream the harness fixes and #13764 fix design - both are first-filer positions
   with upstream's own issue load (~25-35% resource-related) as evidence of demand.
