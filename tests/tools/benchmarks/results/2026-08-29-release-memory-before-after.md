# Release Memory: base vs experimental (F1-F5) — negative result

Date: 2026-08-29
Builds: base `b3dd46d4` vs `exp/memory-release` (`f5cd6812`), both `build:unpack`
(--dir, unsigned), renderer built with `--mode e2e` so the fixture bridge is
available (identical on both sides).
Harness: `config/scripts/run-release-memory-benchmark.mjs` (W1), standard
fixture: 1 local git repo workspace, 4 terminal tabs, editor + browser tab
flags. 120s idle sampling @2s. Fully isolated launch (ORCA_E2E_USER_DATA_DIR,
isolated HOME, mock keychain) so the stable instance is untouched.

## Result: experimental is WORSE, not better

| metric (median RSS) | base MB | exp MB | delta MB |
|---|---:|---:|---:|
| renderer | 246.3 | 356.3 | **+110.0** |
| main | 187.6 | 253.6 | **+65.9** |
| gpu | 84.8 | 105.1 | +20.3 |
| daemon | 68.1 | 71.7 | +3.6 |
| utility | 49.7 | 52.2 | +2.5 |
| **total** | **636.5** | **838.8** | **+202.3** |

Renderer heap snapshot totalSelf bytes are ~equal (4.4 vs 4.3 MB), so the
renderer delta is not JS-heap objects measured by the snapshot summary; it is
RSS (native/committed) growth. Run-to-run variance on earlier 60-90s runs was
large (renderer median swung 230MB→940MB), so treat magnitudes as noisy — but
three exp runs were all ≥ base; the sign is consistent.

## What this is NOT

- F4 was a no-op by design (host-mirror replay buffers are structurally
  bounded; see 2026-08-29-f4-host-mirror-replay-buffer.md), so it cannot hurt.
- F1 (warp worker teardown), F2 (SQLite pragmas), F5 (pressure monitor, inert
  at idle) should each be neutral-to-negative at idle. F1/F2/F5 are unlikely
  causes of +66MB main.
- The `--mode e2e` store exposure is present in BOTH builds.

## Leading suspects (unresolved)

1. **F3 (lazy Monaco)**: counter-intuitively, the dynamic `import()` of
   monaco-setup creates a separate async chunk. If something still pulls it at
   startup (e.g. a module-level re-export or the placeholder path mounting
   eagerly), the split may load MORE (duplicate monaco instances in chunk
   graph) or defeat tree-shaking. Needs `build:electron-vite` chunk comparison
   base vs exp.
2. **Heap snapshot / CDP noise**: heap snapshot summaries were taken in both
   runs; snapshot allocation can inflate renderer RSS (native memory outside
   JS heap). But both sides take the same snapshots.
3. **pnpm/vite nondeterminism**: builds came from different worktrees; the
   f2-lane build-speed commits (tsc incremental) are in exp — packaging
   differences possible but shouldn't change runtime RSS.

## Conclusion

The plan's success criteria (renderer −30-60MB, main −10-30MB) are NOT met;
the measured direction is opposite. Do not ship W3 from these numbers. Next
steps: (a) bisect per-fix with the harness (F1/F2/F5 individually, then F3
with chunk-graph diff), (b) longer idle windows to beat variance, (c) keep the
harness itself — it found this.
