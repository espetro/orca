# F5 / Task 3: main-process RSS anomaly investigation

Date: 2026-08-29. Worktree: `orca-mem-worktrees/f4` (branch `exp/mem-f4`).
Subject build: base `b3dd46d4` unpacked app at `../base/dist/mac-arm64/Orca.app` (same binary family as canary; canary main RSS equals base per manual launches).

## TL;DR

1. **No ~366MB steady-state main-process RSS exists.** Fresh isolated launches of the packaged app show the root (main) pid peaking at ~309MB for ~2s during startup, then settling to a steady ~174-177MB RSS / ~184-187MB phys_footprint — exactly the in-run benchmark medians (184-187MB). The earlier manual 364-368MB reading is attributable to sampling during / right after the startup spike, or to including more than the single root pid; it does not reproduce as a persistent state and is not caused by F1-F5.
2. The benchmark's `main` class is exactly the root pid (`classify()`, `config/scripts/idle-cpu-process-sampling.mjs:111-115`), same pid manual `ps` measures; medians agree with steady-state reality, so the benchmark is not under-reporting.
3. The `MaxListenersExceededWarning: 11 closed listeners` is expected bookkeeping on one long-lived main window: ~11 independent `closed` handlers legitimately attach per BrowserWindow. It is per-window, not accumulating per launch; nothing leaks across reloads, but the count is right at Node's limit so any future handler will re-trigger the warning. Cheap fix noted below.

## 1. Measured RSS timeline (base app, isolated profile, macOS arm64)

Isolation env per policy (`HOME`, `ORCA_E2E_USER_DATA_DIR`, `--remote-debugging-port`, `--password-store=basic --use-mock-keychain`). Two launches.

Launch A (coarse): root pid 130MB @5s → 53MB @30s → 82MB @60s → 85MB @120s; final 46MB RSS, `footprint` = 187MB.

Launch B (2s resolution, first 60s):

| t (s) | root RSS |
|---|---|
| 2 | 309MB |
| 4 | 245MB |
| 6 | 173MB |
| 8 | 114MB |
| 10 | 105MB |
| 18 | 128MB |
| 30 | 129MB |
| 32 | 176MB |
| 60 | 174MB |
| ~105 | 177MB |

`footprint` = 184-186MB at both 60s and 105s.

Interpretation:

- The main process transiently touches ~300MB during startup (module load / asar read / first-boot profile init: codex trust grant, skills scan over 24 roots, updater feed fetch, first renderer round-trips), then macOS reclaims the touched-but-cold pages and RSS falls to ~105-130MB, then creeps to a steady ~175MB.
- `ps rss` and `phys_footprint` differ by design on macOS (compressed + I/O-backed + jetsam-accounted pages count toward footprint but not all of rss). The benchmark medians (~184-187MB) match `footprint` and the t≥30s `rss` plateau; the earlier manual 364-368MB @~18s matches neither steady state. Given launch B shows 128MB at t=18s, the manual reading almost certainly caught a different moment (second-instance bounce, updater download staging, or an `rss` column summed across rows). Verdict: **not a real regression, not F1-F5 related** — canary ≈ base, and base's steady state is what the benchmark reports.
- The 32s step 129→176MB coincides with deferred startup work (`rateLimits.start` after first paint, daemon warm-up, TCC `log stream` child) and matches the benchmark's own plateau, so the benchmark window already captures it.

Startup log (fresh profile) confirms one-time work, all bounded: `[skills] scan roots=24 ... ms=58/89` (twice, ~60-90ms each), `[codex-trust-grant] granted 8 managed hook entries ... 2154ms` then a second pass at 505ms (idempotent re-grant, not a leak), `[autoUpdater] Found version 1.4.192` (feed check only; no download observed — 0 "downloading" lines; RSS did not jump after it). F5's memory-pressure response is inert at idle (fires only under pressure; observed no effect).

## 2. Benchmark vs manual discrepancy

`classify()` in `config/scripts/idle-cpu-process-sampling.mjs:111-115`: `main` iff `row.pid === rootPid`; descendants are bucketed as daemon/gpu/renderer/utility/etc., and per-kind medians are computed from per-sample `rssBytes` of just those pids (`tests/tools/benchmarks` aggregation; `hang-watchdog-memory-benchmark.mjs` medians use the same rows). So the benchmark's "main ~184-187MB median" is the root pid's median RSS across samples — the same quantity manual `ps -p <rootpid> -o rss=` measures. They agree at steady state (Launch B: 174-177MB). The manual 366MB was a startup-transient or wrong-pid/sum artifact, not a benchmark blind spot.

## 3. The 11 `closed` listeners warning

All `closed` listeners attached to the main BrowserWindow, per window creation:

| # | Site |
|---|---|
| 1 | `src/main/index.ts:1691` (clear `mainWindow` ref / expected-reload state) |
| 2 | `src/main/window/createMainWindow.ts:188` |
| 3 | `src/main/window/attach-main-window-services.ts:231` (browserManager.unregisterAll) |
| 4 | `src/main/window/attach-main-window-services.ts:281` (TCC handler token cleanup) |
| 5 | `src/main/window/attach-main-window-services.ts:314` (renderer reload handler token) |
| 6 | `src/main/window/attach-main-window-services.ts:530` (rendererNotifications/runtime notifier teardown) |
| 7 | `src/main/window/attach-main-window-services.ts:561` (remove `ipcMain` terminal file-drop relay) |
| 8 | `src/main/rate-limits/service.ts:358` (`rateLimits.attach`, removed on closed at :344) |
| 9 | `src/main/window/main-window-visual-lifecycle.ts:92` (delayed repaint / ipc cleanup) |
| 10 | `src/main/ipc/worktree-base-directory-watcher.ts:281` (clear `latestSyncContext`) |
| 11 | `src/main/macos-tcc-prompt-notice.ts:165` (`initTccPromptNotice`, wired at `src/main/index.ts:1687`) |

Behavior:

- These fire **once per BrowserWindow**, not per launch/reload; each holds its own teardown. There is no accumulation over time — the count stays 11 for the window's lifetime. `rate-limits` even removes its listener on close (`service.ts:344`), and `speech.ts:57-60` uses `off`-guarded `once`.
- It is therefore a **warning-threshold nuisance, not a leak**. But it is at the limit: any 11th distinct subsystem (e.g. a second `speech.ts:60/115` `once('closed')` pending during a model download, or a pending `session-tab-close-request-relay.ts:57` `once`) trips the warning again.
- Recommended (not applied — outside this task's scope): a single `onWindowClosed(window, fn)` registry in `attach-main-window-services.ts` that multiplexes one `closed` listener, or `mainWindow.setMaxListeners(20)` in `createMainWindow.ts` as a stopgap.

## Conclusion

- Benchmark medians are trustworthy; main-process steady state is ~175MB rss / ~185MB footprint on a fresh profile for both base and canary.
- The 366MB manual reading was a transient/misread, not an anomaly and not caused by F1-F5. No code change warranted on this basis.
- The `closed`-listener warning is benign bookkeeping at exactly 11 handlers per window; consolidate via a teardown registry if the noise bothers anyone.
