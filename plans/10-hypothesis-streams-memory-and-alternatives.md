# Hypothesis Streams: Memory Reduction + Extended Electron Alternatives

Date: 2026-08-29
Status: research synthesis. Companion to `09-radical-hypotheses-architecture-and-alternatives.md` (read §5 verification first — several "wins" there died).
Inputs: 8 research lanes (xterm tuning, xterm alternatives, Deno Desktop, bun-compile daemon, missed renderer/main streams, Electrobun v1/v2, Tauri minimal-Rust + Pake, plus the earlier verification round).

---

## 0. TL;DR

| Stream | Verdict |
|---|---|
| Optimize xterm.js setup | Ceiling ~0.2-0.3MB/pane idle tuning; real lever is lifecycle policy (~1.5-2.5MB/hidden pane) — mostly already done by parking |
| Replace xterm.js | **No.** No alternative beats tuned xterm.js for a multi-pane WebGL IDE; wterm lacks search/serialize/ligatures/GPU renderer |
| Deno Desktop migration | **No.** No multi-webview, no partitions, no offscreen; TS-compat buys ~nothing (migration cost is platform surface, ~769 ipcMain sites); RAM delta ≈ 0 |
| Daemon → `bun --compile` | **No.** node-pty broken under Bun (#28925 segfault, #25822 no onData); fork/execPath/IPC architecture conflicts; daemon's 300-400MB is session data, not runtime |
| Electrobun v1/v2 | **No.** v2.0 is 1 week old; fails offscreen/powerMonitor/crash-reporting/native-addons outright; same system-webview class already rejected |
| Tauri minimal-Rust + Pake | **No.** Rust floor real (~100-300 LOC) but blockers are product capabilities (multiwebview unstable, no offscreen, cookie partitions open since 2024); node sidecar makes memory math net-zero. Pake: category error |
| **New memory candidates (renderer+main)** | **Yes — the only surviving wins:** C2 pressure response (unblocks #16214), C7 theme-worker teardown leak, C4 SQLite pragmas, C3 partition reaper, C8 mirror-buffer cap check, C9 GPU selection, plus prior lazy-Monaco top win |

**The composite answer to "minimum resource usage" is unchanged: stay on Electron, ship the thin-shell trajectory, and work a short list of concrete memory candidates. Every framework swap nets ~zero memory for this app class.**

---

## 1. xterm.js optimization (tuning)

Current: `@xterm/xterm` 6.1.0-beta.287 with 4 orca-local patches (package.json:326-329). Full DOM Terminal per pane (`pane-dom-creation.ts:41`), 5k scrollback default, addons fit/search/serialize/unicode11/web-links always + ligatures conditional + WebGL if GPU. Park = serialize + dispose (full), not hide. Retained-hidden bounded to 4 worktrees/15min with the repo's own measurement: **~2.5MB/pane V8 heap at 5k rows, ~19MB at 50k** (`terminal-hidden-worktree-retention.ts:14-18`). WebGL atlas already shared cross-terminal (CharAtlasCache).

Upstream state 2025-26: 6.0 DI/disposables + scrollbar rework landed; perf PRs (#5403 SearchLineCache, #5066 marker dispose, #4936 leak fix) already in the beta orca uses. **The typed-array buffer rework (#1530) remains unmerged since 2018** — the per-cell memory floor won't move without quarters-scale upstream work.

Tuning ceiling: **~0.2-0.3MB/pane** (lazy addons, marker/decoration hygiene, `customGlyphs:false` trade). Lifecycle-policy ceiling: ~1.5-2.5MB per evicted/demoted hidden pane — but scrollback demotion-on-hide was deliberately removed (retention.ts:20-23), so that's a product conversation, not a PR.

## 2. xterm.js replacement

- **wterm** (vercel-labs, v0.3.4 Aug 2026, active): Zig core ~12KB WASM + optional libghostty core ~400KB, DOM renderer, virtualized scrollback. Plausibly ≤1MB/pane. But: **no search, no serialize, no ligatures, no GPU renderer** — orca's whole terminal surface dies. Niche: if native DOM selection/find/a11y ever matters.
- **alacritty_terminal via WASM/napi**: zero prior art (0 repos embed it); desktop-oriented crate not wasm-friendly.
- **libghostty**: exists as `@wterm/ghostty` WASM core; AppKit/NSView embedding into Electron: no project exists (ghostty discussion #14034 is discussion-stage).
- **Headless-in-worker hybrid**: serialize() is escape-sequence replay (O(scrollback), lossy-ish), not zero-copy; VS Code prior art is process-separation, not memory saving. Only useful for robustness.

**Verdict: nothing beats tuned xterm.js on memory for this product. Revisit when wterm grows a GPU renderer + search/serialize equivalents.**

## 3. Deno Desktop (adversarial result — hypothesis rejected)

Re-verified repo surface: **769** ipcMain sites (not 155), 343 webContents calls, 12 BrowserWindow constructions with 542 refs, webview/partition/offscreen coupling deeper than estimated (`browser-page-webview.ts`, `profile-project-session-transfer.ts:186`, `browser-tab-create-publication.ts` offscreen placement).

Deno Desktop (2.9, experimental): one webview per window, no `<webview>`/WebContentsView equivalent (independent reviewers agree: "VS Code/Figma-class → Electron"), no session partitions, no offscreen, webview backend has **no DevTools**, no Windows auto-update/MSI, macOS notarization manual. Memory claims (3x less) are hello-world-class; orca's footprint is webview-dominated, and WKWebView guests still run separate WebKit processes. CEF backend = ~150MB Chromium = Electron's cost with fewer features.

**The TS-compat premise conflates language with platform.** ~60-70% of code is portable in principle but the Electron integration layer (~0%) is where the 4-7 engineer-months go, for a *worse* result. Posture: **track, don't migrate**; revisit at Deno 2.10+ with multi-webview + Windows update story.

## 4. Daemon → `bun --compile` (rejected)

Load-bearing constraints: orcad is spawned via `child_process.fork` with `ELECTRON_RUN_AS_NODE` + Node IPC channel (`daemon-init.ts:587-620`); node-pty is a lazy-`require`d external with a shipped prebuilt `pty.node` slotted at runtime (`node-pty-prebuilt-slot.ts`); build esbuild-bundles 3 flat entries (build-orcad.mjs).

- **node-pty under Bun is broken**: segfault at spawn (#28925), onData never fires (#25822) — fatal, and orca's is a patched fork.
- fork-in-compiled-binary re-runs the bundle entry, not a sibling JS file — you'd ship a runtime anyway.
- Memory: Bun 1.4 fixed its idle-RSS disaster but soak data is ±20% of Node; the daemon's 300-400MB is **retained session data, identical under any runtime**. Fix is plans/04/05 (budget + dehydration), not the runtime.
- `node --snapshot-blob` helps boot only; daemon boots detached, rarely.

**Verdict: not worth it, conditional spike only after Bun fixes node-pty AND plan-05 lands.**

## 5. Electrobun v1/v2 (rejected)

v2.0.1 stable is **one week old** (2026-08-22); single maintainer who explicitly disclaims reviewing external PRs — fatal for an external fork needing upstreamability. Architecture is genuinely interesting (Cottontail Zig/JSC runtime, Hutch builds, `<electrobun-webview>` custom element with partitions, per-view CEF mixing, best-in-class delta updater) but the verdict table: 2 parity / 5 partial / **4 none** — offscreen rendering, powerMonitor, crash reporting, and native addons/N-API are absent; the 769 ipcMain sites need full rewrite; Bun-base inherits the node-pty breakage.

Ideas worth stealing (not migration arguments): per-view CEF/system renderer mixing; static-host delta-patch updater. Revisit criteria: offscreen + N-API story + powerMonitor/crash APIs + one large multi-webview production adopter.

## 6. Tauri minimal-Rust + Pake (rejected)

The minimal-Rust question answered precisely: **option (b) Tauri + node sidecar** achieves ~100-300 LOC of boilerplate Rust (shell + spawn + port-forward), zero business logic in Rust; official plugins cover the incidental Electron list almost entirely. The Rust surface is genuinely small. But:

- Blockers are **product capabilities, not Rust volume**: multiwebview still `unstable` with layering bugs (#10420); offscreen rendering impossible (no capturePage/CDP outside WebView2); cookie partitions open since 2024 (#9285; macOS-only `dataStoreIdentifier` in 2.9 is the first movement — re-check in ~12mo); Windows per-partition data dirs multiply browser processes.
- Memory math nets **~zero**: Rust shell (~30-60MB) + full Node sidecar (~100-200MB) + WebKit processes replaces Electron's shared Chromium+Node. Only the pure-Rust rewrite (rejected) collects Tauri's RAM story — and the bun sidecar is DOA on node-pty.
- Upstreamability: Cargo toolchain + 3-OS × 2-arch sidecar matrix lands in a TS-only repo whose maintainers can't debug it. Noise.

**Pake**: single-webview URL wrapper, GPL-3.0. Category error for an IDE. No.

---

## 7. The surviving stream: renderer/main memory candidates (NEW)

Verified against source; excludes everything already dead or done in plans/09 §5.

Already-good (no action): i18next lazy locales; STT worker 1h idle teardown; SQLite stmt cache bounded 256; telemetry burst caps; renderer heap headroom tiers.

| # | Candidate | Evidence | Est. MB | Effort | Type |
|---|---|---|---|---|---|
| C2 | **Chromium memory-pressure response + purge-on-minimize** — nothing wired; #16214 hibernation planner is blocked on exactly this signal | grep: no pressure listener; `host-memory.ts:74` read-only | 50-150 reclaimed-on-pressure | M | knob; **unblocks #16214** |
| C7 | **warp-theme parser worker never torn down** (no idle teardown like STT's) | `src/main/warp-themes/` no teardown constant | 10-20 | S | **leak** |
| C4 | **SQLite pragmas unset** (cache_size/mmap_size/journal_mode; node:sqlite default 2MB page cache/conn; scanner workers at 384MB heap cap) | `sync-database.ts:43-57` | 5-20 | S | knob |
| C3 | **session partitions never reaped** — 15+ `fromPartition` sites incl. per-SSH-host and per-provider; no refcount/close on last pane death | `local-ssh-browser-partitions.ts:157,173,210` | 10-60 with N profiles | M | **leak-ish** |
| C8 | **renderer host-mirror replay buffer cap unverified** — `pane.terminal.clear()` workarounds imply a resident per-pane mirror copy | `web-runtime-session.ts:141,1766-1788` | 2.5MB/pane if uncapped | S (verify+cap) | potential leak |
| C9 | **GPU selection knob** (integrated vs discrete on macOS) — configure-process.ts sets many flags, none for GPU choice | `configure-process.ts:281-321` | 30-80 hardware-dependent | S-M | knob |
| C1 | lucide-react import discipline (audit for dynamic icon map) | 821 files, named imports | 0-20 if a dynamic site exists | S | fixed cost |
| C5 | TerminalPane.tsx memo debt (6 memo hits vs 65 in the palette) — GC pressure, not residency | `TerminalPane.tsx` | 0 direct | S-M | transient garbage |
| C6 | lazy provider slices (linear/jira/github) out of boot store | `store/index.ts:64-116` | 5-15 | M | fixed cost; refactor risk |

Not candidates (checked): ipcMain registrations (flat map, closures needed anyway); hang-watchdog thread (deadlock protection, keep); skills residency; pet cache (known, small).

---

## 8. Final decision matrix

| Path | Memory gained | Effort | Risk | Upstreamable |
|---|---|---|---|---|
| **Short list**: lazy Monaco (prior #1) + C7 + C4 + C8-verify | ~40-90MB | S each | low | high |
| **C2 pressure response** | 50-150 reclaimed | M | medium | high — unblocks #16214, strategic |
| plans/04+05 budget+dehydration | 100MB+ (daemon) | M-L | medium | via maintainer ack on #17033 |
| Any framework/runtime swap (Deno/Electrobun/Tauri/bun) | **~0** | 4-7 eng-months | high | no |

Recommended sequence: (1) measure packaged build (falsify/confirm dev-build confound), (2) issue-first for C7 + C4 (S, leaks/knobs), (3) propose C2 as the #16214 unblock with the pressure-signal design, (4) keep lazy-Monaco as the top renderer PR, (5) re-evaluate Deno Desktop + Tauri #9285 in ~12 months.
