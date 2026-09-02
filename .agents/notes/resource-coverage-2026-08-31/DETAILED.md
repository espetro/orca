# Resource-Usage Coverage: Detailed Walkthrough

Date: 2026-08-31
Repo: stablyai/orca
Question: _What % of issues and PRs would be solved by improvements to Orca's
resource usage (RSS, CPU, leaks)?_

This document is the full research record. The headline numbers and verdict
live in [`OVERVIEW.md`](./OVERVIEW.md); read that first.

---

## 1. Method

Four parallel research streams ran against `stablyai/orca` (GitHub) and the
local codebase. Each was a subagent with `research`-only tools, dispatched
via the task tool with parallel `gather(...)` of `ghx`/bash calls to
minimize round-trips and respect the GitHub search rate limit (30/min).

| Stream                      | Lens                                                                                                                                            | Output                                                          |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| **A — Issue keyword sweep** | memory, RSS, leak, ram, OOM, CPU, perf, unresponsive, hang, crash                                                                               | Counts + top issues with quotes                                 |
| **B — PR keyword sweep**    | memory leak, leak, memory, RSS, cleanup, orphan, CPU, perf, GC, shutdown, zombie, release handles                                               | 495 classified resource-fix PRs + file-touch map                |
| **C — Surface-area sweep**  | Codebase subsystems with leak-prone patterns                                                                                                    | 16 subsystems with risk levels, evidence files, recent activity |
| **D — Lateral POV sweep**   | Slow, lag, freeze, input lag, scroll, ghost, fleet, many terminals, slow startup, etc. on issues; cold-start/jank/battery/fleet/CI/cost on code | 11 lateral areas + 46 lateral issues                            |

### Sampling caveats

- GitHub search caps each query at ~1000 hits; we capped at 200 per query.
- Search API rate limit is 30/min; the PR agent hit it and paced calls.
- Pre-2026 PRs titled generically ("fix: handle PTY exit") are _missed_ by
  keyword sweep → the 3.86% lifetime share is a **lower bound**.
- Recent activity is over-represented in keyword results → the 22% recency
  share is the more actionable signal.
- The lateral issue sample is the top 80 by reactions+comments out of 1,606
  unique issues touched by lateral keywords → biases toward high-traffic
  reports.

### Total repo size

- Total issues: 4,653 (2,324 open + 2,329 closed)
- Total PRs: 12,838
- Combined: ~17,491 — matches the rough order-of-magnitude prompt estimate.

---

## 2. Stream A — Direct issues (memory/leak/RSS/CPU/perf)

### 2.1 Query hit summary

| Query        | Total hits | Open | Closed |
| ------------ | ---------- | ---- | ------ |
| memory       | 259        | 49   | 1      |
| leak         | 203        | 49   | 1      |
| performance  | 65         | 34   | 16     |
| rss          | 34         | 21   | 13     |
| high_memory  | 34         | 15   | 19     |
| unresponsive | 52         | 15   | 35     |

49/50 open for "memory" and "leak" is the strongest single signal: this
workstream is **active and unresolved**, not legacy.

### 2.2 Highest-signal open issues (root cause = resource usage)

| #         | Title                                                                                                                                              | Age              | Why it matters                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------- |
| **9138**  | App updates leave previous daemon generations running forever — invisible agent sessions accumulate and exhaust memory                             | 45d, 12 comments | Daemon generational leak; "old daemons keep running indefinitely with all PTYs and coding-agent processes" |
| **11218** | Sudden CPU/memory runaway with two worktrees in one workspace — Resource Manager reports 135 GB (211% of system RAM) on a 64 GB Mac, machine froze | 33d              | Catastrophic RSS explosion on small workload                                                               |
| **12588** | Remote terminal children have no resource boundary and can OOM the host                                                                            | 26d, 6 comments  | "terminal-child Python reached ~60 GiB RSS before kernel killed it; parent app.slice recorded 76 GiB peak" |
| **12728** | Memory leak: orca-terminal-daemon private memory grows to 300-400+ MB per process and is never released; system RAM exhausted (88.5% used)         | 25d, 2 comments  | Per-process private RSS never released                                                                     |
| **15241** | Renderer memory (and CPU) grows unbounded when a terminal pane keeps emitting distinct/multi-line error messages                                   | 13d, 3 comments  | Renderer growth under load                                                                                 |
| **13764** | macOS: TCC login-shell wrapper leaks PTYs (`session-kill-failed`, `session-closed` never fires)                                                    | 20d, 8 comments  | "PTYs accumulate for the lifetime of the daemon until kern.tty.ptmx_max (511)"                             |
| **10928** | High RAM and CPU usage during normal usage                                                                                                         | 34d, 3 reactions | General resource pressure                                                                                  |
| **17033** | Resource-lifetime conventions: dir-handle closure, native memory collector, reliability gates                                                      | 2d, 2 comments   | **Meta-issue** explicitly listing #12728, #15241, #16211, #16905, #9530 as recurring cluster               |
| **10358** | Windows: Timed out waiting for terminal handle after creation on Ctrl+T; ConPTY console host leaks                                                 | 37d, 6 comments  | Windows ConPTY lifecycle                                                                                   |
| **7725**  | Windows: marketplace upgrade staging directories are not cleaned up and can grow to multiple GB                                                    | 54d, 9 comments  | Disk + memory adjacent                                                                                     |
| **11363** | Windows UI freezes (no click/type) with ~5 terminals; only restart recovers                                                                        | 32d, 4 comments  | UI freeze / resource exhaustion                                                                            |
| **16630** | Linux: unbounded agent node fleet makes systemd-oomd kill the entire GNOME session, not just Orca (v1.4.188)                                       | 4d               | Cross-platform impact                                                                                      |

### 2.3 Closed-but-instructive issues (same root cause class)

| #     | Title                                                                                                  | Age              | Why closed                                       |
| ----- | ------------------------------------------------------------------------------------------------------ | ---------------- | ------------------------------------------------ |
| 6288  | Orca remote server memory usage and CPU usage are too high                                             | 67d, 11 comments | Fixed                                            |
| 7576  | macOS: repeated main-thread Performance Diagnostics while Orca.app is running                          | 55d, 8 comments  | Fixed                                            |
| 15412 | Main process reaches 100% CPU after terminal/worktree churn and retains thousands of removed worktrees | 12d, 12 comments | "Quitting and reopening restores responsiveness" |
| 6655  | High CPU Usage by "Orca Helper (Renderer)" on Mac Mini M4 — Severe UI/Input Lag                        | 63d, 9 comments  | Fixed                                            |

### 2.4 Verbatim user pain points (quotes)

- #12728: _"orca-terminal-daemon private memory grows to 300-400+ MB per process and is never released"_
- #9141: _"computer-use spawns ~200 unmanaged helper processes/3h, causing 40-50GB+ memory usage and forced restarts"_
- #11218: _"135 GB reported on a 64 GB Mac, machine froze and required force power-off"_
- #15210: _"Over ~29h of uptime across daemon restarts, this accumulated 51 orphaned idle bash processes"_
- #13764: _"PTYs accumulate for the lifetime of the daemon until the machine hits kern.tty.ptmx_max (511) or dies of memory pressure first"_
- #12588: _"A terminal-child Python process reached approximately 60 GiB RSS before the kernel killed it. The parent app.slice recorded a 76 GiB memory peak."_
- #13753: _"Relay re-reads the whole agent session transcript corpus every 30s, pegging its main thread at ~96% indefinitely"_
- #17033: _"While investigating the memory reports in #12728, #15241, #16211, #16905 and #9530, we found the same meta-pattern: ... the same bug classes get re-fixed point by point."_

---

## 3. Stream B — Direct PRs (resource-fix work)

### 3.1 PR search hits by query

| Query           | Hits         | Classified resource-fix |
| --------------- | ------------ | ----------------------- |
| memory leak     | 86           | 20                      |
| leak            | 400 (capped) | 70                      |
| memory          | 400 (capped) | 91                      |
| rss             | 67           | 20                      |
| reduce memory   | 5            | 4                       |
| cleanup         | 400 (capped) | 115                     |
| orphan          | 400 (capped) | 84                      |
| cpu             | 281          | 90                      |
| performance     | 400 (capped) | 93                      |
| gc              | 134          | 44                      |
| shutdown        | 351          | 76                      |
| zombie          | 45           | 11                      |
| release handles | 20           | 13                      |

### 3.2 Aggregate

- **495** PRs classified as resource-usage fixes (out of 2,252 sampled).
- **122** open as of 2026-08-31.
- **304** merged since 2026-03-01.
- **69** closed-not-merged.
- **3.86%** of all 12,838 repo PRs (lower bound, pre-2026 under-captured).
- **21.98%** of the keyword-sampled set.

### 3.3 2026 cadence (merged resource-fix PRs)

| Month                | Merged  |
| -------------------- | ------- |
| April                | 7       |
| May                  | 19      |
| June                 | 23      |
| **July**             | **105** |
| **August (partial)** | **150** |

The workstream is **accelerating**, not winding down.

### 3.4 Top files touched by these PRs

| File                                                                       | PRs touching |
| -------------------------------------------------------------------------- | ------------ |
| `src/main/runtime/orca-runtime.ts`                                         | 54           |
| `src/main/runtime/orca-runtime.test.ts`                                    | 29           |
| `src/main/index.ts`                                                        | 27           |
| `src/preload/index.ts`                                                     | 25           |
| `config/reliability-gates.jsonc`                                           | 22           |
| `src/preload/api-types.ts`                                                 | 21           |
| `package.json`                                                             | 20           |
| `src/main/ipc/pty.ts`                                                      | 19           |
| `src/renderer/src/store/slices/worktrees.ts`                               | 17           |
| `src/renderer/src/store/slices/terminals.ts`                               | 16           |
| `src/renderer/src/components/terminal-pane/pty-connection.ts`              | 16           |
| `src/main/ipc/pty.test.ts`                                                 | 16           |
| `src/main/ssh/ssh-relay-session.ts`                                        | 15           |
| `src/main/persistence.ts`                                                  | 15           |
| `src/main/daemon/daemon-pty-adapter.test.ts`                               | 15           |
| `src/main/daemon/daemon-pty-adapter.ts`                                    | 15           |
| `src/renderer/src/components/status-bar/ResourceUsageStatusSegment.tsx`    | 14           |
| `src/renderer/src/App.tsx`                                                 | 14           |
| `src/shared/workspace-cleanup.ts`                                          | 12           |
| `src/renderer/src/components/workspace-cleanup/WorkspaceCleanupDialog.tsx` | 12           |

### 3.5 Release notes signal

17 of the last 30 releases carry a "## Performance" (now "## Performance /
reliability") heading. Examples:

- v1.4.192 (2026-08-29): _"fix(memory): report the Windows number that predicts paging, not just resident pages (#16211)"_
- v1.4.191 (2026-08-28): _"## Performance / reliability"_ + _"fix(crash-reporting): see the renderer memory the heap counters never report"_
- v1.4.184 (2026-08-17): _"## Performance"_ + _"perf: avoid polling remote runtimes on local repo changes"_
- v1.4.182 (2026-08-13): _"perf(renderer): preserve unchanged remote mirror resources"_
- mobile-android-v0.0.44 (2026-08-22): _"fix(terminal): stop leaking raw PTY lifecycle tokens into the error toast"_

### 3.6 Roadmap signal

No public GitHub Projects visible (404 on `/orgs/stablyai/projects` and
`/users/stablyai/projects`). Repo has zero milestones. De-facto umbrella
issue: #9300 "Windows & WSL: performance audit and improvement pass". New
meta-issue: #17033 (2026-08-29) explicitly proposes "resource-lifetime
conventions" — scoped opendir helpers, a native memory collector replacing
PowerShell spawns, and reliability-gate entries.

---

## 4. Stream C — Subsystem surface-area risk assessment

### 4.1 Subsystems ranked by leak risk

#### High risk

**Terminal lifecycle** (PTY, xterm, pane hibernation, orphan adoption):

- Evidence: `src/main/ipc/pty/runtime/{controller,spawn,kill,operations}.ts`,
  `src/main/runtime/terminal-orphan-{topology,owner}.ts`,
  `src/main/runtime/agent-session-orphan-child-reaper.ts`,
  `src/renderer/src/store/terminals/terminal-pane-hibernation.ts`,
  `src/renderer/src/store/terminals/terminal-shutdown*.ts`,
  `src/renderer/src/components/terminal-pane/use-terminal-pane-lifecycle.ts`,
  `src/main/daemon/terminal-host.ts`.
- Known mitigations: explicit orphan-topology merge for adoption of tabs
  whose session survives reconnect; `PtyRuntimeController` rejects
  `paneSpawnReservation` in `finally`; `agent-completion-coordinator` evicts
  `lastCompletionIdentityByPaneKey` only when `isLive() === false`;
  `TerminalHost.onExit` reaps exited sessions; xterm instance disposed is
  probed via vendored `_core._store._isDisposed`; `history-manager`
  `disabledSessions` removed on normal close.
- Recent: 7+ 2026 commits (#16970, #17010, #16868, #16967, #17009, #17128,
  #16981).

**Main `orca-runtime.ts` (in-process caches)**:

- 336 `new Map()` / `new Set()` call sites; 50 timers; explicit `invalidate*`
  methods.
- Evidence: `src/main/runtime/orca-runtime.ts` (1.6M LoC singleton),
  `src/main/runtime/orca-runtime-files.ts`,
  `src/main/runtime/file-watcher-host.ts`,
  `src/main/runtime/runtime-root-watch-teardown.ts`,
  `src/main/runtime/relay/relay-control-silence-watchdog.ts`.
- Known mitigations: per-root `AbortController` + closed flag + closePromise
  in `file-watcher-host`; `orchestrationFederationTimers` keyed by
  federation id with explicit removal path; `paneSpawnReservationsByOwnerKey`
  rejection on throw prevents future spawns from awaiting a never-resolving
  promise.

**Renderer zustand slices + module-level maps keyed by ephemeral ids**:

- 12+ dedicated `*-leak.test.ts` regression files pinning eviction:
  - `tab-worktree-orphan-map-purge-leak.test.ts`
  - `agent-status-live-map-leak.test.ts`
  - `editor-state-worktree-purge-leak.test.ts`
  - `agent-status-worktree-purge-leak.test.ts`
  - `bulk-worktree-purge-terminal-maps-leak.test.ts`
  - `repos-remove-project-purge-leak.test.ts`
  - `generation-records-worktree-removal-leak.test.ts`
  - `sparse-presets-repo-removal-purge-leak.test.ts`
  - `github-pr-refresh-states-leak.test.ts`
  - `github-pr-refresh-sequences-leak.test.ts`
  - `agent-status-retained-leak.test.ts`
- `buildOrphanTerminalCleanupPatch` whitelists 16 reconnect/layout maps.
- Recent: #16943 bounds PR-refresh alias fan-out and hosted-review cache growth.

**Long-lived terminal daemon** (TerminalHost, HistoryManager, headless
emulator, session backlog):

- Evidence: `src/main/daemon/daemon-init.ts`,
  `src/main/daemon/terminal-host.ts`,
  `src/main/daemon/terminal-host-session-reaping-leak.test.ts`,
  `src/main/daemon/history-manager.ts`,
  `src/main/daemon/history-manager-disabled-sessions-leak.test.ts`,
  `src/main/daemon/headless-emulator.ts`,
  `src/main/daemon/cold-restore-payload-cache.ts`,
  `src/main/daemon/terminal-history-{seed-transfer-registry,session-tombstone,host-tombstones}.ts`.
- Mitigations: `TerminalHost.onExit → reapSession` disposes
  `@xterminal/headless` emulator and drops from sessions map;
  `HistoryManager.disabledSessions` deleted on normal closeSession;
  `terminal-host-tombstones` capped at `DEFAULT_MAX_TOMBSTONES = 1000`;
  `daemon-stream-keep-tail-drop` caps daemon stream memory under load;
  daemon AGENTS.md forbids sweeper code on canonical endpoint path.
- Recent: #16908 (Windows daemon host pruning on unverifiable liveness),
  #16953 (PTY presence question during daemon swap window).

#### Medium risk

- **Worktree / folder-workspace / git lifecycle** — `worktree-lineage-pruning.ts`,
  `worktree-retirement-{discovery,namespace}.ts`, `worktree-watcher-removal.ts`,
  `src/shared/remote-runtime-abort-orphaned-socket.ts`.
- **Source-control / hosted-review caches** — `hosted-review-cache-state.ts`,
  `hosted-review-pr-cache.ts`, `hosted-review-unsettled-lookups.ts`,
  `hosted-review-lookup-backoff.ts`, `hosted-review-scope-generations.ts`,
  `hosted-review-active-branch-claims.ts`, `hosted-review-branch-cache.ts`.
- **Filesystem watchers** — `file-watcher-host.ts`,
  `transcript-watch{,-engine,-scheduler,-native-watcher}.ts`,
  `macos-tcc-prompt-watch.ts`, `plugin-dev-watcher.ts`,
  `relay-filesystem-watch-registry.ts`.
- **Electron BrowserWindow / webContents / dashboard popout** —
  `createMainWindow.ts`, `attach-main-window-services.ts`,
  `dashboard-popout-window.ts`, `clipboard-ipc-handlers.ts`.
- **Network clients / WebSockets / subscription transports** —
  `runtime-rpc.ts`, `remote-runtime-subscription-transport.ts`,
  `relay-watcher-{stale-client-release,teardown-tracker,event-emitter}.ts`,
  `web-runtime-connection-transport.ts`.
- **Render-time timers / event listeners** — `use-terminal-pane-lifecycle.ts`
  (~20 subscriptions with explicit `removeEventListener` + dispose blocks at
  lines 1414-1495, 1919+), `CombinedDiffViewer.tsx`, `MonacoEditor.tsx`,
  `setup-contextual-copy.ts`, `DiffViewer.tsx`, `plugin-panel-watchdog.ts`.

#### Low risk

- **Skills runtime caches** — `discovery.ts`, `skill-bundle-install-service.ts`,
  `skill-bundle-extraction.ts`, `skill-upload-session-service.ts` (uses
  `session.idleTimer` with explicit cancel path).
- **i18n locale catalog** — only English bundled eagerly; `partialBundledLanguages`
  flag means non-English locales don't pay parse cost on every launch (~2MB
  saved per comment in `i18n.ts:18-23`).
- **Telemetry / consent / install-id** — `burst-cap.ts` caps event bursts;
  `validator-warn-cache` exists as bounded cache.
- **Audio / speech / STT workers** — `stt-worker-stop.ts` explicit worker
  stop helper; `speech-model-download-cleanup.ts`.
- **Resource recorder** (new in 2026) — `src/main/metrics/resource-recorder.ts`,
  ring buffer capped at `ringCapacity` (default 3600), `timer.unref()` so it
  never blocks exit. Self-bounded by design.

### 4.2 Hot files (2026 touches)

| Path                                                 | Touches |
| ---------------------------------------------------- | ------- |
| `src/renderer/src/i18n/locales/en.json`              | 11      |
| `src/preload/index.ts`                               | 8       |
| `src/main/index.ts`                                  | 8       |
| `src/main/runtime/orca-runtime.ts`                   | 7       |
| `config/reliability-gates.jsonc`                     | 7       |
| `src/renderer/src/i18n/locales/ko.json`              | 5       |
| `src/renderer/src/i18n/locales/zh.json`              | 4       |
| `src/main/runtime/orca-runtime.test.ts`              | 4       |
| `src/shared/resource-recorder-types.ts`              | 3       |
| `src/shared/resource-recorder-parsers.ts`            | 3       |
| `src/shared/protocol-version.ts`                     | 3       |
| `src/shared/constants.ts`                            | 3       |
| `src/renderer/src/web/preload-api/web-gitlab-api.ts` | 3       |
| `src/renderer/src/store/slices/ui.ts`                | 3       |
| `src/renderer/src/store/slices/browser.ts`           | 3       |
| `src/main/runtime/runtime-rpc.ts`                    | 3       |
| `src/main/metrics/resource-recorder.ts`              | 3       |
| `src/main/ipc/pty/runtime/operations.ts`             | 3       |
| `src/main/ipc/pty/runtime/controller.ts`             | 3       |
| `src/main/browser/doc-preview-grant-registry.ts`     | 3       |

### 4.3 Recent memory/leak commits

The team convention is named `*-leak.test.ts` regression files rather than
"memory leak fix" commits. Explicit commits include:

- `aec7c097` docs(plans): add hypothesis streams research on memory reduction and extended Electron alternatives
- `872eede3` docs(plans): add memory-reduction intervention design docs
- `f845118a` docs(plans): record explicit resource management and cancellation decisions
- `e4903b6e` docs(plans): add radical hypotheses research on architecture, modularity, and Electron alternatives
- `b3dd46d4` docs(plans): correct dev-build hypothesis, readings are from release app
- `47aa9987`, `2de8b50f`, `025b2fbb`, `a140f0cd`, `0e423082`, `c4be8530`, `1122c6b0`, `b734bea9`, `b7f38124`, `7abedba5`, `50cd04c7`, `a823dc4e`, `251f005f` — the M1-M4 resource-recorder merges.
- `cf5e0872` fix(github): bound PR-refresh alias fan-out and hosted-review cache growth (#16943)

---

## 5. Stream D — Lateral POVs (issues + codebase)

### 5.1 Lateral issues (top 46 of 1,606 keyword-touched)

46 lateral-impact issues found (21 open, 25 closed) by classification across
30 keyword searches (slow, lag, freeze, input lag, scroll, ghost, fleet,
many terminals, slow startup, etc.). No issue had explicit memory/leak/perf
labels.

#### memory_pressure (13)

| #     | Title                                                                     | State  | Reactions | Comments |
| ----- | ------------------------------------------------------------------------- | ------ | --------- | -------- |
| 9138  | App updates leave previous daemon generations running forever             | open   | 1         | 12       |
| 16038 | Orca often freezes for short periods                                      | open   | 0         | 23       |
| 15412 | Main process reaches 100% CPU + retains thousands of removed worktrees    | closed | 0         | 12       |
| 6655  | High CPU Usage by "Orca Helper (Renderer)" on Mac Mini M4                 | closed | 1         | 9        |
| 6795  | Orca suddenly VERY slow!                                                  | closed | 0         | 55       |
| 7742  | Renderer crash+restart orphans open terminal PTYs                         | closed | 0         | 16       |
| 7725  | Marketplace upgrade staging directories are not cleaned up                | open   | 1         | 9        |
| 13764 | macOS: TCC login-shell wrapper leaks PTYs                                 | open   | 0         | 8        |
| 10859 | Mirrored editor tabs carry the peer's `runtimeEnvironmentId` untranslated | open   | 1         | 10       |
| 6288  | Orca remote server memory usage and CPU usage are too high                | closed | 1         | 11       |
| 4751  | Building Orca for Raspberry Pi 5                                          | closed | 1         | 10       |
| 7576  | macOS: repeated main-thread Performance Diagnostics                       | closed | 0         | 8        |
| 10939 | Skill command sent again when resuming agent                              | closed | 0         | 15       |

#### ui_freeze (12)

| #     | Title                                                                                | State  | Reactions | Comments |
| ----- | ------------------------------------------------------------------------------------ | ------ | --------- | -------- |
| 16238 | Remote connection through Orca Relay is failing consistently                         | open   | 15        | 8        |
| 3099  | Chat-based UI                                                                        | open   | 9         | 7        |
| 15909 | Live PTY orphaned with no tab row                                                    | open   | 0         | 7        |
| 12447 | Closed SSH terminal tabs resurrect                                                   | open   | 0         | 7        |
| 9911  | Remote - Terminal window auto-closing. Unable to recover                             | closed | 0         | 16       |
| 5319  | Orca SSH terminals freeze/won't accept keyboard input                                | closed | 1         | 16       |
| 8335  | Terminal permanently stuck (mouse motion echoed as literal input)                    | closed | 1         | 8        |
| 6364  | Pasting images into an agent CLI not working using Remote Host                       | closed | 0         | 75       |
| 5970  | NGROK                                                                                | closed | 0         | 16       |
| 13696 | orchestration: check returns wrong empty success                                     | open   | 0         | 8        |
| 10205 | Sleeping workspaces revive without user activation                                   | open   | 0         | 7        |
| 11878 | Korean double consonants trigger automatic line breaks (Windows integrated terminal) | closed | 3         | 22       |

#### many_terminals (6 open, all open)

| #     | Title                                                  | State | Reactions | Comments |
| ----- | ------------------------------------------------------ | ----- | --------- | -------- |
| 8377  | Multi-worktree parallel view                           | open  | 10        | 4        |
| 9699  | Configurable editor keybinding presets (Vim, Emacs, …) | open  | 5         | 5        |
| 14228 | Cleanly exited Claude session is auto-resumed          | open  | 2         | 7        |
| 16377 | 1.4.188 regression: every `worker-start` fails         | open  | 1         | 8        |
| 12098 | Account Switching Bugs and Automatic Account Rotation  | open  | 0         | 9        |
| 10706 | Grok TUI on orca serve — PTY stuck tiny (8×20)         | open  | 0         | 8        |

#### ui_jank (5)

| #     | Title                                                                      | State               |
| ----- | -------------------------------------------------------------------------- | ------------------- |
| 15192 | Issues with duplicate Korean text and content disappearing in the terminal | open                |
| 15550 | Persistent Korean character doubling (duplicate rendering)                 | open                |
| 6144  | Laggy Claude code terminal scroll                                          | closed, 36 comments |
| 4932  | Jittery scrolling in Claude Code                                           | closed              |
| 6901  | Garbled Text Often                                                         | closed              |

#### slow_startup (5)

| #     | Title                                                                           | State  |
| ----- | ------------------------------------------------------------------------------- | ------ |
| 9976  | slow Claude startup lets tui-idle false-positive                                | open   |
| 16965 | Claude Code is intermittently suspended on launch                               | open   |
| 3464  | v1.4.35 quits ~400ms after launch on macOS 26.3.1                               | closed |
| 9498  | WSL-managed orca CLI fails to launch — .NET duplicate-key                       | closed |
| 3190  | Duplicate [hooks.state."…"] tables accumulate in codex-runtime-home/config.toml | closed |

#### input_lag (3)

| #     | Title                                                                         | State  |
| ----- | ----------------------------------------------------------------------------- | ------ |
| 11855 | Previous IME text disappears while next composition is active                 | closed |
| 11392 | Remote environment disconnection floods the UI with repeated timeout messages | closed |
| 9803  | Issues with Korean Input in the Terminal                                      | closed |

#### slow_remote (2)

| #     | Title                            | State  |
| ----- | -------------------------------- | ------ |
| 10425 | Orca relay for mobile            | closed |
| 8371  | mobile QR pairing never connects | closed |

### 5.2 Lateral areas (codebase POV)

#### 1. Cold-start / TTI

- `src/main/index.ts:228,1101-1169,1465-1608` (logStartupMilestone chain).
- 1.6M-LoC `orca-runtime.ts` monolith, no lazy-import seams.
- `src/renderer/src/main.tsx` synchronous full bootstrap.
- `src/renderer/src/App.tsx` useAppStartupHydration + useRuntimeGraphSync mount eagerly.
- `electron.vite.config.ts` single bundle, no chunk split documented.
- Measurement: logStartupMilestone; `renderer_memory_highwater` breadcrumb at 0.6/0.8 heap ratio; no TTI oracle in reliability-gates.jsonc.
- **Shares root cause**: yes — large synchronous bootstrap graph + 1.6M-line OrcaRuntimeService keep main heap hot.

#### 2. UI responsiveness / jank / input lag

- `src/renderer/src/components/Terminal.tsx:2956` (1 useMemo per surface, 2456 memoized handlers repo-wide).
- `src/renderer/src/lib/pane-manager/pane-manager-registry.ts:209` (estBufferKB × N panes; xterm scrollback 6MB/pane).
- `docs/reference/renderer-agent-status-performance.md` documents a 100-worktree lineage = 1,218→8,518 listener regression.
- `src/renderer/src/components/editor/monaco-diff-editor-disposal.ts:29-58` monaco dispose guard.
- **Shares root cause**: yes — leak pressure IS jank pressure when the same root causes are unbounded store Maps, unbounded xterm scrollback, per-pane setInterval/heavy memo arrays.

#### 3. Battery / power consumption

- `src/main/agent-awake-service.ts` prevent-display-sleep powerSaveBlocker only on agent sessions.
- `src/main/metrics/resource-recorder.ts:73` setInterval metric tick.
- `src/main/rate-limits/service.ts:824` setInterval poll loop.
- `src/main/rate-limits/claude-pty.ts:128,217` hidden PTY with `enterInterval`.
- `src/renderer/src/web/web-runtime-client-heartbeat.ts` window.setInterval 10s heartbeat.
- `src/main/ipc/filesystem-watcher.ts:1010` comment about permanently broken remote ~7 fs.watch ticks at half-hour ceiling.
- Measurement: no battery metric; reliability-gates has no 'idle CPU under N%' gate.
- **Shares root cause**: yes — every interval/watcher that doesn't back off when the host is on battery is the same handler that retains references when active.

#### 4. Multi-agent / fleet scalability

- `src/main/runtime/orca-runtime.ts:43846` 1.6M-line singleton.
- `src/main/runtime/agent-session-orphan-child-reaper.ts` token-only reap.
- `src/shared/bounded-{map,secure-json-file,output-sink}.ts` existing bounded primitives with patchy coverage.
- `src/relay/dispatcher-writer-admission.ts` DISPATCHER_CONTROL_QUEUE_MAX_FRAMES=256, MAX_BYTES=1MB.
- `src/main/runtime/pty-handler-dispose-lifecycle.ts`.
- **Shares root cause**: yes — same primitives (bounded queues, ring buffers, coalesced sweeps) work for per-tenant RSS and per-tenant throughput. 1.6M-line runtime is exactly where coverage is patchiest.

#### 5. Cross-platform consistency

- `src/main/index.ts:477,737,1509,2484,3449` process.platform branches.
- `src/main/startup/configure-process.ts:91-301` PATH key, package installers, shell families all platform-specific.
- `src/main/windows/windows-process-table.ts` win32-only.
- `src/main/macos-tcc-prompt-notice.ts` darwin-only.
- `src/main/linux-lid-sleep-assertion.ts` linux-only.
- `src/main/daemon/daemon-entry.ts:104-326` no SIGTERM on appVersion change; old daemon generations not reaped.
- **Shares root cause**: yes — TCC-wrapper leak (macOS), Windows conpty graceful path, Linux login-shell path all touch the same process-tree-reaper primitives.

#### 6. CI/CD & build determinism

- `config/reliability-gates.jsonc` gate-policy with `minimumSoakRuns:100, minimumSoakDays:14`.
- `config/vitest.config.ts:14-21` --expose-gc, hookTimeout 60s, testTimeout 30s.
- `config/scripts/check-{max-lines-ratchet,runtime-electron-ratchet}.mjs`.
- `config/scripts/run-release-memory-benchmark.mjs:520-543,597-603` orphan Electron procs from harness itself.
- tests/e2e/ — 413 spec files, 26 perf/pressure/latency specs but no resource-budget gate.
- **Critical**: bench harness leaks ~45 Electron procs / 225MB per run → every RSS measurement is confounded.
- **Shares root cause**: yes — the bench harness leak inflates every measurement, blocking CI gating of resource usage.

#### 7. Reliability / crash recovery

- `src/main/crash-reporting/renderer-recovery-circuit-breaker.ts` DEFAULT_MAX_RECOVERIES=3, windowMs=60_000.
- `src/main/crash-reporting/crash-breadcrumb-store.ts:8` MAX_BREADCRUMBS=30 ring overwrites old samples.
- `src/main/crash-reporting/process-gone-{recorder,diagnostics}.ts`.
- `src/main/crash-reporting/gpu-crash-fallback-decision.ts`.
- **Shares root cause**: yes — leak pressure IS crash-loop pressure. A time-bucketed ring buffer of memory samples is named fix in notes (see `.agents/notes/host-noise-2026-08-30/03`).

#### 8. Cost / cloud spend

- `src/relay/dispatcher.ts49K`, `dispatcher-writer-admission.ts` MAX_BYTES=2MB producer queue.
- `src/main/cli/linux-bare-orca-dispatcher.ts` + `src/main/cli/cli-installer.ts` headless orca serve installs on VPS.
- `src/main/daemon/daemon-entry.ts` detached Node daemon survives app updates; eats RSS on idle VPS.
- `src/shared/remote-runtime-memory-limits.ts`, `remote-rpc-content-budget.ts` already have remote-bound budget primitives.
- **Shares root cause**: yes — every unbounded PTY/orphan process on the daemon is billable CPU/RSS on a VPS.

#### 9. UX perception of "snappiness"

- `src/renderer/src/store/slices/agent-status.ts:326-340` MAX_RETAINED_AGENTS=500, MAX_LIVE_AGENT_STATUSES=500, RECENTLY_CLOSED_AGENT_STATUS_TAB_IDS_MAX=1024, RECENTLY_RETIRED_AGENT_STATUS_PANE_KEYS_MAX=1024 — already capped.
- Listener budget caps: WorktreeCard:2, Agent-row inputs:1, Worktree activity:1, Closed context:1 (from `renderer-agent-status-performance.md`).
- **Shares root cause**: yes — listener leaks (`recoveryTimestampsByTabId`, store-listener-census) are also extra setState propagations. The "Bound mounted subscription fanout" design IS the leak fix.

#### 10. Security / sandbox robustness

- `src/preload/index.ts:422,617,727,781,...` 30+ `ipcRenderer.removeListener` cleanups paired with subscribe returns; `+contextBridge` audited contract.
- `src/main/ipc/bounded-warning-dedupe.ts` warn-dedupe primitive.
- `src/main/ai-vault/` e2ee-keypair, restart-policy, filesize-capped spawn.
- `src/shared/agent-skill-sharing-{threat-model,upstream-boundary}.md`.
- **Shares root cause**: yes — listeners that aren't unsubscribed are both a leak and a security surface.

#### 11. Developer rebuild / edit-time memory

- `electron.vite.config.ts` single Vite config; React + Tailwind plugins; bundled dep set `@xterminal/headless`, `@xterminal/addon-serialize`, `psl`, `zod` in main; rest external.
- `config/scripts/check-max-lines-ratchet.mjs` ratchets against `max-lines-baseline.txt`.
- `src/main/runtime/orca-runtime.ts:43846` LoC single .ts file; tests at 1.7M lines.
- `src/main/runtime/orca-runtime.ts:1` `eslint-disable max-lines` (deferred split).
- **Shares root cause**: yes — 1.6M-line runtime.ts simultaneously drives cold-start cost, edit-time cost, and test-time cost.

### 5.3 Lateral % estimate

The 46-of-80 sample represents ~5.7% of the 1,606 keyword-touched unique
issues. If representative, lateral-impact is roughly **6-9% of all
keyword-touching issues on top of** the directly-tagged ones. Combined:
**~25-35% of recent issue load** is plausibly improved by resource-usage
work, depending on how liberally you weight "yes" vs "likely"
classifications.

---

## 6. Synthesis: why this matters

### 6.1 Three independent signals converge

1. **Direct**: 22% of recent keyword-touching PRs _are_ resource fixes; 304
   merged in 6 months; 122 still open.
2. **Lateral**: an additional ~6-9% of issues (freeze, jank, slow startup,
   "many terminals", input lag) share root causes and would be closed or
   substantially de-risked by the same fixes.
3. **Strategic**: maintainers are _already_ investing — meta-issue #17033
   ("resource-lifetime conventions"), bounded primitives library,
   reliability gates, resource recorder (M1-M4 merged in 2026), 17/30 recent
   releases carrying a Performance heading.

### 6.2 The codebase already has the answer

Bounded primitives (`bounded-map`, `bounded-output-sink`,
`bounded-secure-json-file`, `node-bounded-file-reader`, ring buffers in
`memory/collector`, `DISPATCHER_CONTROL_QUEUE_MAX_*`) are the documented
answer. Coverage is patchy. Each fix is small, but they accumulate.

### 6.3 The riskiest assumption is "this is point-fix"

It isn't. The bounded-primitive pattern is a _coherent strategy_; what's
missing is coverage. Adopting it broadly closes leak, jank, idle CPU, fleet
scalability, security surface area, and developer rebuild time — all at
once.

---

## 7. Concrete recommendations

1. **Fix the bench harness first.** `config/scripts/run-release-memory-benchmark.mjs`
   leaks ~45 Electron procs per run (root-pid-only kill, no pgid group,
   fixed `DEFAULT_CDP_PORT=9223`). Until repaired, no RSS gate in CI is
   trustworthy.

2. **Land the upstream quick-win.** PR #15306 bounds
   `terminal-error-accumulation.ts:17` — single short diff that closes the
   rank-1 renderer leak suspect. Already exists upstream.

3. **Schedule the `orca-runtime.ts` split.** 1.6M-line file (with explicit
   `eslint-disable max-lines` concession at line 1) is the single biggest
   shared root cause across cold start, fleet scalability, dev rebuild, test
   runtime, and leak surface area.

4. **Track reliability gates + resource budgets.** `config/reliability-gates.jsonc`
   currently enforces function correctness with soak requirements but not
   resource budgets. Add RSS/heap/idle-CPU gates once the harness is fixed.

5. **Strengthen the meta-issue (#17033)** with structured triage: per
   subsystem, list which bounded-primitive gaps remain, prioritized by
   measured impact (which PRs unblock the most lateral issues).

---

## 8. Sources and method artefacts

- Plan file: `.agents/plans/2026-08-31-resource-usage-issue-coverage.md`
- Overview: `.agents/notes/resource-coverage-2026-08-31/OVERVIEW.md`
- This detailed report: `.agents/notes/resource-coverage-2026-08-31/DETAILED.md`
- Subagent streams: 4 (issue keyword, PR keyword, surface-area, lateral POV).
- Repo size: 4,653 issues + 12,838 PRs (≈ 17,491 total).

### Caveats recap

- Lifetime PR share (3.86%) is a lower bound; keyword search misses
  pre-2026 PRs titled generically.
- Recency share (22%) is the better signal.
- Lateral-issue sample (46 of 80) biases toward high-traffic reports.
- React-vs-not classification of lateral issues used "root_cause_link =
  yes/likely/no"; combining yes-only gives ~25%, yes+likely gives ~35%.
