# Ideas

- sqlite `mmap_size=0` variant of F2: page-cache cap alone may leave mmap'd pages counted in main RSS; try disabling mmap reads entirely in `src/main/sqlite/sync-database.ts`
- WAL checkpoint tuning: aggressive `wal_checkpoint(TRUNCATE)` on idle to shrink the WAL mapped region
- V8 heap limit flags: `--max-old-space-size` / `--max-semi-space-size` in main process args to bound heap growth at idle
- Renderer chunk splitting: split large static chunks so unused panes never resident (check `out/renderer/assets` chunk sizes after a bench build)
- Idle-time GC hints: schedule `global.gc()`-style pressure or v8 idle notifications in main once startup settles
- Deferred service starts: lazily start non-critical main-process services (ssh registry, automations, preflight) on first use instead of boot

# Priors to read

- `tests/tools/benchmarks/results/RESOURCE-BENCH-PLAYBOOK.md`
- `tests/tools/benchmarks/results/memobs-null/null-ab-verdict.json` (null-result A/B verdict)
- F1/F2/F3 bisect verdicts may land in `tests/tools/benchmarks/results/memobs-bisf1..3` separately. Read if present; do not block on them. Until then treat F1 (warp theme worker teardown), F2 (sqlite WAL + page-cache cap), F3 (lazy Monaco loading) as unresolved hypotheses.
