# Ideas

## Metric upgrades (do these BEFORE trusting any loop verdict - RSS primary is too noisy)

- Switch primary to phys_footprint: `ps -o phys_footprint=` silently fails on modern macOS (keyword removed). Use `/usr/bin/footprint -p <pid>` per tick in `src/main/metrics/resource-recorder.ts:165` (replaces the ps fallback; works on this host) or proc_pidinfo(PROC_PIDTASKINFO). This is the Chromium/Slack-recommended macOS metric (pre-compression, stable under GC).
- Force GC before sampling: CDP `HeapProfiler.collectGarbage` at window end (or `--js-flags=--expose-gc` in the bench app), then a single post-GC snapshot as the metric - Chrome memory-infra's deterministic-dump practice. Kills the decay-transient (last<boot) problem.
- Noise: half-spread of per-run medians ~38MB >> deltas; consider Mann-Whitney U + Cliff's delta over per-run medians instead of pooled tick medians (skew-robust, standard for perf A/B), and --runs 5 for confirm runs.

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

# Host-noise issues (known, 2026-08-30)

This machine had real memory-pressure sources that inflate benchmark noise. Before trusting a marginal delta, sweep these:

- Daemon terminal leak (Orca bug): the installed app's daemon leaks orca-tcc-login/zsh shells over days (185 found, ~950MB). Kill stale ones before benchmarking; the leak itself is a candidate lead (session reaping) once the loop works on main-process RSS.
- Orphaned dev-build Electron procs from prior bench runs (~45 found, ~225MB): sweep `pgrep -f orca-mem-worktrees` / `orca/dist` before runs; leftover app processes both consume memory and can interfere via the shared CDP port.
- The installed production Orca (renderer 465MB after 1d4h) runs concurrently with benchmarks and is the main machine-load source behind the noise floor. If deltas look noisy, quit it during measure runs and note that in asi.
- Long-run renderer growth (465MB after ~1 day) is itself evidence of retention worth investigating later, but it is out of scope for the idle-RSS metric.

# Loop experiment ideas (2026-08-31 research pass)

- V8 flags as loop experiments: --max-semi-space-size, --max-old-space-size
- Buffer hygiene: Buffer.from(chunk.subarray(...)) copies vs pinned parents; allocUnsafeSlow for persistent small buffers
- GC telemetry via perf_hooks PerformanceObserver(entryTypes:['gc']) for allocation-rate signal (needs in-app hook; later iteration)
- Rejected: malloc_trim/MALLOC_CONF (glibc/jemalloc only; macOS uses its own allocator)
- Rejected: `--single-process` (crashes Electron with node-pty/webviews/CDP, drops process security/isolation)

## Candidate Levers for Autoresearch Loop (2026-09-02)

1. **Chromium Low-End Device Mode (`--enable-low-end-device-mode`)**:
   - Forces `base::SysInfo::IsLowEndDevice() == true`.
   - Halves image decode caches, drops compositor tile headroom, and aggressively discards hidden tab caches.
2. **Renderer Process Limit Tuning (`--renderer-process-limit=2` vs `4`)**:
   - Caps total renderer processes spawned for webviews/previews to prevent unbounded process growth.
3. **Full GPU Process Disabling (`--disable-gpu` / `--disable-software-rasterizer`)**:
   - Eliminates the ~155MB Chromium GPU process entirely for headless or extreme low-memory environments, falling back to Canvas/DOM terminal rendering.
4. **Native Code Caching (`NODE_COMPILE_CACHE` / Chromium Script Cache)**:
   - Evaluates warm startup time gains (-200ms) and transient AST heap spike reduction vs disk footprint.
5. **Linear / Jira Cache Unspreading**:
   - Selective field extraction when storing issues in Zustand rather than spreading raw API payloads.
6. **Background Tab Auto-Hibernation**:
   - Unmounting terminal DOM for tabs idle > 5 minutes while preserving PTY headless stream.
