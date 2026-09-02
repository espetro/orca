# Resource Bench Playbook

How to run memory/resource A/B comparisons for Orca release builds, read the
verdicts, and know when not to trust a number.

## When to cite which metric

| Metric                      | What it is                                                                                          | Cite it for                                                                              |
| --------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `rssBytes`                  | Resident set size from `ps`/appMetrics. Includes shared pages (Chromium mappings, mmap'd DB pages). | Never cite alone for "app grew".                                                         |
| `footprintBytes`            | macOS `phys_footprint`: pages charged to this process, excluding most shared mappings.              | The authoritative per-process cost on macOS. Default citation for "process X uses N MB". |
| `workingSetKb`              | Electron `appMetrics` working set. Can double count shared pages on macOS.                          | Cross-check only.                                                                        |
| `mainProcess.heapUsedBytes` | V8 JS heap in use in the main process.                                                              | Distinguishing JS growth from native/mmap RSS growth.                                    |

On non-macOS hosts `footprintBytes` is `null` in dumps. Never read that as zero.

## Running an A/B

```sh
pnpm bench:release-memory --ab <path/to/appA> <path/to/appB> --runs 3 \
  --settle-s 30 --window-s 120 --out-dir tests/tools/benchmarks/results/<name>/
node config/scripts/resource-metrics-analysis.mjs \
  tests/tools/benchmarks/results/<name>/run-*-A-*.json \
  tests/tools/benchmarks/results/<name>/run-*-B-*.json \
  --out report.md --json artifact.json
```

Protocol: runs are interleaved (A,B,B,A,A,B at `--runs 3`) to spread thermal and
host-load effects across both sides. Single-run comparisons are not verdicts.

## Reading verdicts

Each metric gets exactly one of:

- `improved` / `regressed`: the two sides' interquartile ranges are disjoint.
  The delta is real at this sample size, in the direction of the median
  difference. Lower is improved for memory and CPU metrics.
- `inconclusive`: IQRs overlap. The honest reading is "no demonstrated
  difference", not "no difference". Do not convert a small median delta into a
  claim.

## Deviance flags (when to distrust numbers)

Flags appear per side and are printed above the verdict table:

- `drift-suspected`: monotonic growth over the window. A leak suspect, but it
  also invalidates "median of window" comparisons. Extend `--window-s` and
  re-run.
- `marker-step`: a step change aligned with a `mark()` event. Compare segments
  between markers instead of whole windows.
- `thermal-limit`: macOS CPU speed limit below 100 during the window. CPU
  metrics are unusable; memory may shift too. Re-run later.
- `host-degraded-source`: available-memory came from the `free-memory`
  fallback rather than `memory_pressure`. Host context is lower fidelity.
- `loadavg-spike`: external load burst during the window. Re-run.
- `snapshot-taken-in-window`: a heap snapshot ran inside the sampling window.
  Snapshots perturb the heap; discard this window for heap metrics.
- `stale-samples` / `low-sample-count`: recorder health problems. The stats
  are not representative.

Rule of thumb: any flag on either side downgrades the verdict. Report flags
prominently; do not bury them under the table.

## Known confounds

- Heap snapshots inflate the next window; they run only after the window closes
  (marked `snapshot-taken`), but stay out of your comparison windows regardless.
- mmap'd SQLite pages count toward RSS and, on some paths, footprint. A config
  change in mmap size shows up as a "memory regression" with no behavioural
  difference. Test `mmap_size=0` variants before attributing.
- First-run transients: profile creation, onboarding, and chunk-cache warming
  make the first minute unrepresentative. The 30s settle exists for this; use
  `mark('fixture-ready')` segments.
- Single-instance lock: packaged builds relocate userData only via
  `ORCA_E2E_USER_DATA_DIR`; the harness already sets it plus an isolated HOME.
  Do not bypass it or runs collide with the stable instance's daemons.
- Editor/browser panes dominate renderer memory. Fixes targeting terminal or
  startup memory are only evaluable on the `--no-editor` fixture.
- macOS GPU process memory is unbudgeted by appMetrics role sums; check
  footprint for the gpu type before attributing renderer totals.

## Null test first

Before any real A/B, run A vs itself (same build both sides). The verdict must
be `inconclusive` on every metric. If it is not, the chrome or the host is
lying; fix that before measuring anything else.
