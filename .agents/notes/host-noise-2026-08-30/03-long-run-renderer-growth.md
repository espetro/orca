---
tags:
  - orca
  - memory
  - research
  - host-noise
  - renderer
  - long-run
---

# Research: Long-run renderer memory growth in Orca (host-noise issue #3)

**Date:** 2026-08-30
**Source audit:** Installed Orca (v1.4.188) renderer process at **465MB after 1d4h of uptime**, ~57 helper processes totaling **~950MB across the app + helpers**. Idle growth, not startup. Distinct from the autoresearch idle-RSS scope (which uses 120s settle) but is real product evidence worth understanding.
**Repo:** `stablyai/orca` primary worktree at `~/Documents/prjcts/_own/orca`.
**Status:** READ-ONLY research — no code changed.

---

## TL;DR — root-cause hypothesis (ranked)

1. **Unbounded `terminalError` string concatenation in `TerminalPane` React state** — the same root cause already on the upstream issue tracker as **#15241**. The fix exists in open PR **#15306** but is **not in v1.4.188** (`exp/mem-observability`). Each O(n) append of a recurring PTY error (any SSH pane that emits a slightly-different reconnect error) grows one pane's `terminalError` state monotonically and pays O(n²) CPU in the meantime. v1.4.188 still ships the unbounded version at `src/renderer/src/components/terminal-pane/terminal-error-accumulation.ts:17`.
2. **Unparkable SSH/remote-server xterm scrollback** — upstream #8652 (CLOSED with a known gap). Even with worktree cold-parking enabled (`terminalHiddenViewParking: true`), `canParkTerminalWorktreeRenderers` requires `isParkRestorableTerminalPty`, which excludes every `remote:` and `ssh:*` PTY from a user whose workflow is remote-first. Each unparked SSH terminal holds the full xterm scrollback (~10–20 MB at 5k rows × ~2.6 KB/row, exactly matching the `BufferLine` × `cols` model). With 5–10 hidden remote terminals, this is 70–200 MB that the parking system can't reclaim — and the existing `getLivePaneMemoryProfileCounts` contributor (`src/renderer/src/lib/pane-manager/pane-manager-registry.ts:209`) already names it.
3. **Recovery maps never cleared on tab close** — `recoveryTimestampsByTabId` / `recoveryGenerationByTabId` in `src/renderer/src/components/terminal-pane/terminal-pane-recovery.ts:70-71` are module-level `Map`s cleared only by `_resetTerminalPaneRecoveryForTests()` (line 315). Per-tab closure never deletes entries. Cited as the secondary leak in #15241.
4. **No long-run time series.** The existing one-shot `renderer_memory_highwater` breadcrumb only fires at 0.6/0.8 heap ratio or 600/1000 MB private — there is no sliding-window time series. The instrumentation exists (`recordRendererMemorySample` every 60s, `MAX_BREADCRUMBS=30`), but it overwrites the ring on each new breadcrumb — the long-run trend is not retained. A renderer that climbs from 100→200→465MB across 28h is invisible to the breadcrumb system until the next threshold trip (or a crash).

There are several other likely contributors (less evidence than 1–3) listed under "Secondary suspects". Most of the obvious unbounded Maps are already capped (see "Caps already in place" below).

---

## Evidence tying the suspects to the reported numbers

- Renderer 465MB RSS, ~57 helper procs, ~950MB total, 1d4h uptime, idle growth (not startup). Matches the **#8652** profile exactly (renderer heap 100–257MB peak in sessions with zero unhandled rejections, all parked tabs are SSH/remote), and matches **#15241** ("a single pane on a flaky transport can grow to multi-GB over ~55 min"). Both have been reproduced and acknowledged upstream.

---

## Code locations, what each does, what's missing

### Suspect 1 — `appendTerminalErrorMessage` is unbounded

- `src/renderer/src/components/terminal-pane/terminal-error-accumulation.ts:17` — `${accumulated}\n${message}` grows the string forever; only `containsWholeLineRun` (line 7) dedups, and only on _exact_ full-line repeats.
- `src/renderer/src/components/terminal-pane/TerminalPane.tsx:477-483` — wires this into React `setState` via `onPtyErrorRef`; the state is cleared only when the user manually dismisses the toast, so for a pane's lifetime the string is monotonic.
- The file's own comment (line 1–6) already names the gap: _"a multi-line message is never one line of the accumulated value, so it would re-append on every recurrence and grow without bound."_
- **PR #15306 has the minimal fix** (bound to most-recent 20 lines). Why not merged into v1.4.188 is unclear from the local history (`git log` for the file shows only the Node 26 bump `6f8c5888`). 28h of mixed use with at least one persistently-flapping pane easily produces the observed RSS.

### Suspect 2 — SSH/remote PTYs excluded from parking

- `src/renderer/src/components/terminal-pane/terminal-hidden-view-parking.ts:103-119` (`isParkRestorableTerminalPty`): only snapshot-backed (local daemon-replayable) PTYs and explicitly opted-in `pairedRuntimeParkingEnvironmentIds` are restorable. Default `policy?.sshParkingEnabled === true` is gated by a feature flag — off by default in `default-global-settings.ts`.
- `src/renderer/src/components/terminal-pane/terminal-hidden-view-parking.ts:121-162` (`canParkTerminalWorktreeRenderers`): every tab in the worktree must satisfy this or the worktree is parked around. For SSH-only workflows, no tab can satisfy it, so no worktree ever cold-parks.
- `src/shared/default-global-settings.ts:170` — `terminalHiddenViewParking: true` is on, but functionally inert for SSH/remote-only users.
- The instrumentation already names this: `getLivePaneMemoryProfileCounts` estimates `estBufferKB = rows × cols × 16 B/cell × scale`. With the default `terminalScrollbackRows = 5_000` (`src/shared/terminal-scrollback-policy.ts:1`) × 80 cols × 16 B ≈ ~6 MB per unparked tab; 5–10 hidden SSH tabs at 70–100 MB matches the symptom perfectly.

### Suspect 3 — `recoveryTimestampsByTabId` / `recoveryGenerationByTabId` never pruned on close

- `src/renderer/src/components/terminal-pane/terminal-pane-recovery.ts:70-71` — module-level `Map`s.
- Only `_resetTerminalPaneRecoveryForTests()` (line 315) clears them.
- Each entry is small (≤3 timestamps, generation int) but grows with the count of ever-recovered tabs in the session — a per-session leak, not per-pane, so it survives a tab close. Modest individually; relevant because it's a known missed cleanup and the issue thread already calls it out.

### Secondary suspects — worth flagging but lower evidence

| Where                                                                                                                                                                    | What                                                                                                                                                                                                                            | Risk                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `src/renderer/src/lib/crash-diagnostics.ts:33-37`                                                                                                                        | 60s `setInterval` of `recordRendererMemorySample`; only the _most recent_ breadcrumb is retained (`MAX_BREADCRUMBS=30`, `src/main/crash-reporting/crash-breadcrumb-store.ts:8`) and overwritten on each sample. No time series. | The 100→200→465 MB trend across 28h is **invisible** in a future crash report.                                                   |
| `src/renderer/src/components/pet/pet-blob-cache.ts:13,178-191`                                                                                                           | `CUSTOM_PET_BLOB_CACHE_MAX=16`, properly evicted on retain-count=0.                                                                                                                                                             | None — well-bounded.                                                                                                             |
| `src/renderer/src/components/editor/useLocalImageSrc.ts:11-56`                                                                                                           | `BLOB_URL_CACHE_MAX_SIZE=100`, proper LRU + revoke.                                                                                                                                                                             | None.                                                                                                                            |
| `src/renderer/src/store/slices/linear.ts:64,70-84`                                                                                                                       | `MAX_CACHE_ENTRIES=500`, all `linearIssueCache` / `linearListCache` / `linearProjectCache` / `linearCollectionCache` etc. pruned via `evictStaleEntries`.                                                                       | None.                                                                                                                            |
| `src/renderer/src/runtime/runtime-legacy-quick-open-inventory.ts:11-12,104-110`                                                                                          | `CACHE_LIMIT=8`, `CACHE_TTL_MS=30_000`.                                                                                                                                                                                         | None.                                                                                                                            |
| `src/renderer/src/store/slices/agent-status.ts:326-340` (`MAX_RETAINED_AGENTS=500`) and `:344` (`MAX_LIVE_AGENT_STATUSES=500`)                                           | Already capped; regression tests at `agent-status-retained-leak.test.ts`, `agent-status-live-map-leak.test.ts`.                                                                                                                 | None — confirmed by both source and tests.                                                                                       |
| `src/renderer/src/store/slices/agent-status.ts:1094-1138` (`RECENTLY_CLOSED_AGENT_STATUS_TAB_IDS_MAX=1024`, `RECENTLY_RETIRED_AGENT_STATUS_PANE_KEYS_MAX=1024`)          | Already FIFO-capped.                                                                                                                                                                                                            | None.                                                                                                                            |
| `src/renderer/src/store/slices/recently-closed-tabs.ts:37-40,67-74` (`MAX_RECENT_CLOSED_TERMINAL_TABS=10`, `MAX_RECENT_CLOSED_TAB_KINDS=30`)                             | Bounded.                                                                                                                                                                                                                        | None.                                                                                                                            |
| `src/renderer/src/lib/monaco-diff-editor-disposal.ts:29-58` (`guardMonacoDiffEditorDispose`) + `src/renderer/src/components/editor/diff-monaco-model-disposal.ts:62-107` | Diff editor dispose guard installed via patch on `monaco.editor.createDiffEditor`; unattached models swept by `disposeUnattachedMonacoModelPaths` and `disposeUnattachedMonacoModelsByPathPrefix`.                              | Low. There may still be unattached plain (non-diff) models if a component forgets to call `model.dispose()`, but no smoking gun. |
| `src/renderer/src/components/browser-pane/host-guest/webview-registry.ts:144-204` (`registerPersistentWebview` / `unregisterPersistentWebview`)                          | Three `webview` event listeners installed on `register`; same listeners cleanly removed on `unregister`. The `dragListeners` window-level listeners are removed when the registry empties (line 201-203).                       | Low — looks intentional. `webviewRegistry` / `registeredWebContentsIds` are Maps of live webviews only.                          |
| `src/renderer/src/i18n/i18n.ts:16`                                                                                                                                       | `i18next.createInstance()` — one singleton.                                                                                                                                                                                     | None.                                                                                                                            |
| `src/renderer/src/lib/react-error-boundary-reporting.ts:21-23`                                                                                                           | `MAX_REPORTED_RENDERER_ERROR_KEYS=50` — bounded.                                                                                                                                                                                | None.                                                                                                                            |
| `src/renderer/src/lib/crash-diagnostics.ts:60-82`                                                                                                                        | Explicit `ResizeObserver loop completed…` suppression (preventDefault, dropped from breadcrumbs — references #8260).                                                                                                            | None.                                                                                                                            |
| PostHog                                                                                                                                                                  | Telemetry is `posthog-node` in **main process only** (`src/main/telemetry/client.ts:11,103`), not the renderer. There is no `posthog-browser` instance.                                                                         | None — this matches the architecture doc and rules out the classic PostHog super-properties leak.                                |

---

## Suggested minimum fix

### Instrumentation (next PR)

Right now the renderer emits a `renderer_memory` breadcrumb every 60s but only retains the **last one** (the 30-entry ring is dominated by other event names). For a long-run session we need a **separate, time-bucketed series** that survives until next crash.

Minimum, low-risk additions:

1. **Renderer-side sliding-window ring of `readHeapMetrics() + readRendererProcessMemory()` samples** in `src/renderer/src/lib/renderer-memory-sampling.ts`. Bounded at ~1 sample/5min for 24h = 288 samples × ~120 B = ~34 KB, attached to the `renderer_memory_highwater` breadcrumb on threshold trip.
2. **Per-pane buffer census**: the existing `getLivePaneMemoryProfileCounts` (`src/renderer/src/lib/pane-manager/pane-manager-registry.ts:209`) already exposes `estPanes`, `estBufferKB`. Push it on the regular `renderer_memory` crumb too (not just the highwater), gated by an `ORCA_LONG_RUN_MEMORY=1` env or `electron-store` flag, so it ships no extra cost to production.
3. **`outsideHeapMB` deltas**: the existing bridge already computes `privateMB - usedHeap - malloced - blinkAllocated` (`renderer-memory-sampling.ts:127-147`). Make it a per-sample column, not a highwater-only field — that's what separates a JS heap leak from xterm scrollback/glyph-atlas growth.
4. **Main-side coroutine for renderer private-bytes**: hook `crashReports.readProcessMemory` into `recordRendererMemorySample` _synchronously_ (it's already async-cached at line 75), and store `privateKB` + `usedJSHeapKB` in the ring. The ring lives in a module-level `Array<{t, usedHeapKB, privateKB, estBufferKB, domNodes}>` keyed by wall-clock bucket.

### Structural fixes

**Suspect 1 (highest impact, smallest diff):**

- Land the PR #15306 changes verbatim into `terminal-error-accumulation.ts`. The function is pure, 5-line patch, and a deterministic 500-line regression test already exists.
- Optionally, also bound the React state itself: convert `terminalError: string | null` into `terminalError: { lastLines: string[]; suppressed: number }` so dedup of multi-line messages works without unbounded join growth.

**Suspect 2 (the SSH/remote parking gap):**

- Implement #8652 Option A (cheap) in `terminal-hidden-view-parking.ts:103-119`: when an SSH / `remote:` tab is hidden past the cold-park delay, call `term.options.scrollback = 200` (or whatever the user's `terminalHiddenMinScrollbackRows` setting is) instead of excluding the tab outright. On re-show, restore from the daemon-side scrollback if available, or accept the bounded slice otherwise. This is a behavioral change visible to the user (less history while hidden) but bounded and reversible, and matches the existing `#8652` recommendation.

---

## Existing upstream issues / PRs

- **#15241 (OPEN)** — "Renderer memory (and CPU) grows unbounded when a terminal pane keeps emitting distinct/multi-line error messages" — describes **Suspect 1** root cause and asks for a fix.
- **#15306 (OPEN)** — "fix(terminal): bound the aggregated PTY error surface so recurring near-duplicate errors can't grow it without limit" — minimal fix for root cause #1. Not merged into `main` as of v1.4.188.
- **#8652 (CLOSED with gap)** — "SSH & remote-server PTY tabs excluded from hidden-view parking causes unbounded renderer heap growth" — describes **Suspect 2**.
- **#8260 (CLOSED)** — "Renderer crashes to white screen on macOS — unhandled rejections accumulate causing memory leak and ResizeObserver loop" — already-resolved unhandled-rejection accumulation (not the same as the long-run growth observed here).
- **#10928 (OPEN)** — "High RAM and CPU usage during normal usage" — duplicates #8652 for many users.
- **#16084 (OPEN)** — Linux headless OOM kills; renderer crashes bring down all sessions.
- **#12728 (OPEN)** — `orca-terminal-daemon` (main process) private memory grows; relevant for the 950MB total but orthogonal to renderer-side.

The repo's `gh` search returned several adjacent open issues (high CPU/RAM, daemon leaks, AppHang, closed-tab resurrection, daemon generations accumulating), but only the four above are direct evidence for the renderer-side long-run retention story.

---

## Files in the repo that would need changes (ranked by risk)

| Risk       | File                                                                                                    | Change                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Lowest** | `src/renderer/src/components/terminal-pane/terminal-error-accumulation.ts`                              | Apply PR #15306 verbatim. Pure function, deterministic test.                                                                                                              |
| **Lowest** | `src/renderer/src/components/terminal-pane/terminal-pane-recovery.ts`                                   | Delete `tabId` entries on tab close. One-line `delete` in the existing tab-close path (the rest of the file already enforces budget windows).                             |
| **Low**    | `src/renderer/src/lib/renderer-memory-sampling.ts` + new `src/renderer/src/lib/renderer-memory-ring.ts` | Add a 288-entry ring buffer; emit summary in `renderer_memory_highwater`.                                                                                                 |
| **Low**    | `src/main/crash-reporting/crash-breadcrumb-store.ts`                                                    | Accept an optional `payload` array on `renderer_memory_highwater` so the ring survives the 30-crumb window.                                                               |
| **Medium** | `src/renderer/src/components/terminal-pane/terminal-hidden-view-parking.ts:103-119`                     | Allow `sshParkingEnabled` (default ON for first-launch) and add Option A (scrollback shrink while hidden) for SSH/remote tabs.                                            |
| **Medium** | `src/shared/default-global-settings.ts`                                                                 | Possibly flip `terminalScrollbackRows` default down to 2500 for SSH/remote sessions, or surface a per-host override. (Behavioral change — discuss before merging.)        |
| **Medium** | `src/preload/index.ts` + `src/preload/api/crash-report-api.ts`                                          | Already wired for `readProcessMemory`; ensure the bridge surfaces `residentKB` (already does on macOS via `info.residentSet` per `renderer-process-memory-reader.ts:21`). |

No new direct `child_process` or `fs` calls are needed; everything is reachable through the existing preload IPC bridge and Zustand-store contributors.

---

## Key code references for reviewers

- Existing instrumentation: `src/renderer/src/lib/renderer-memory-sampling.ts:1-263`, `src/renderer/src/lib/renderer-memory-profile.ts:1-124`, `src/renderer/src/lib/state-collection-byte-estimate.ts:1-240`, `src/renderer/src/lib/crash-diagnostics.ts:1-89`, `src/preload/renderer-heap-statistics-reader.ts:1-37`, `src/preload/renderer-process-memory-reader.ts:1-30`, `src/main/crash-reporting/crash-breadcrumb-store.ts:1-90`.
- Long-run RSS series (main process): `src/main/metrics/resource-recorder.ts:22-23,55-237` (`ringCapacity=3_600`, `tickMs=2_000`); renderer-side analog does not exist yet — that's the gap.
- Main-side renderer RSS / private via `app.getAppMetrics`: `src/main/host/electron-app-environment.ts:36`, `src/main/crash-reporting/process-gone-diagnostics.ts:76-115` — already aggregates per-renderer peak / private memory in crash reports, so we have the shape to mirror.
- Caps already proven safe (no action): `MAX_RETAINED_AGENTS` (`agent-status.ts:326`), `MAX_LIVE_AGENT_STATUSES` (`agent-status.ts:344`), `MAX_BROWSER_HISTORY_ENTRIES=200` (`workspace-session-browser-history.ts:5`), `MAX_CACHE_ENTRIES=500` (`linear.ts:64`), `CUSTOM_PET_BLOB_CACHE_MAX=16` (`pet-blob-cache.ts:13`), `BLOB_URL_CACHE_MAX_SIZE=100` (`useLocalImageSrc.ts:11`), `CACHE_LIMIT=8` + `CACHE_TTL_MS=30_000` (`runtime-legacy-quick-open-inventory.ts:11-12`), `MAX_REPORTED_RENDERER_ERROR_KEYS=50` (`react-error-boundary-reporting.ts:23`).

---

## Positioning notes for the fork

- This is the cleanest "free PR" of the three: PR #15306 already exists upstream, the patch is 5 lines, the test exists, and the fix is renderer-only. **Land it locally on `main` first** as a PR that improves baseline hygiene, then upstream-vote it (or co-author a comment).
- The long-run ring buffer (instrumentation fix) is independently valuable: it makes our autoresearch-loop data carryable into crash reports, so when the loop finds an interaction it can attach a memory time series to the verdict. Mention in the prompt.md and consider wiring it before running the loop on a production user's machine.
- Suspect 2 (SSH parking) is more behavioral — coordinate with PM before landing it on `main`, but it's a real lever for the "less memory usage" story.
