---
tags:
  - orca
  - memory
  - research
  - host-noise
  - benchmark-harness
---

# Research: Orphaned Electron processes from `run-release-memory-benchmark.mjs` (host-noise issue #2)

**Date:** 2026-08-30
**Source audit:** ~45 orphaned Electron processes (~225MB) from `orca-mem-worktrees/*` and `orca/dist` dev-builds found after running the memory benchmark harness.
**Repo:** `stablyai/orca` primary worktree at `~/Documents/prjcts/_own/orca`.
**Status:** READ-ONLY research — no code changed, no upstream issue filed yet (this is first-filer territory).

---

## TL;DR

The benchmark spawns Electron with `detached: false` and only kills the **root pid** via `child.kill('SIGTERM')` + `child.kill('SIGKILL')`. On macOS, `child.kill` signals **only the main process** — its GPU/renderer/utility/zygote/helper children and the descendant node-pty/shell processes they spawn are in the same process group as the Node harness, not as the Electron root. SIGTERM to the root does not reach them.

On a mid-run crash (e.g., `HeapProfiler.takeHeapSnapshot` throws `Target page, context or browser has been closed`), the `finally` block in `runOnce` still runs, but signals a pid whose descendants are decoupled from it, and the harness then returns control to the caller (`.auto/measure.sh`) which immediately starts the next `runOnce` on a brand-new app — never reaping the previous tree. The harness also installs no `SIGINT`/`SIGTERM`/`exit` handler, so Ctrl+C or a harness crash leaks the current run entirely.

---

## Code locations

| File:line                                                     | What                                                                                                                                                                        | What's missing                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config/scripts/run-release-memory-benchmark.mjs:520-543`     | `spawn(executable, [...], { detached: false, stdio: 'ignore' })`                                                                                                            | `detached: true` is needed (or `setpgid`) so the spawned process becomes its own pgid leader, then `process.kill(-child.pid, …)` can target the whole group. Right now the child shares the harness's pgid; signals to `-child.pid` would signal the harness's whole session, not the Electron tree.                                                                                                        |
| `config/scripts/run-release-memory-benchmark.mjs:597-603`     | `finally { child.kill('SIGTERM'); sleep(250); if (child.exitCode === null) child.kill('SIGKILL') }`                                                                         | Root-pid-only kill. No `process.kill(-rootPid, …)` group signal. No `pgrep`/`pkill -P` sweep. No `taskkill /T /F` on win32. No `browser.close()` to detach the Playwright CDP page before killing, which is the very thing that lets `target closed` throw.                                                                                                                                                 |
| `config/scripts/run-release-memory-benchmark.mjs:500-636`     | `runOnce` + outer A/B loop                                                                                                                                                  | No `process.on('SIGINT'/'SIGTERM'/'exit')` handler that reaps the active `child`. The top-level `.catch` at line 639-642 calls `process.exit(1)` and returns nothing — a crash in run2 of 6 kills the harness and leaks run 1's tree.                                                                                                                                                                       |
| `config/scripts/run-release-memory-benchmark.mjs:403-412`     | `takeHeapSnapshotSummary(cdpSession)` — registers `cdpSession.on('HeapProfiler.addHeapSnapshotChunk', …)` then awaits `cdpSession.send('HeapProfiler.takeHeapSnapshot', …)` | No `try/catch` around the `send` and no `cdpSession.detach()` in a finally. If the page navigates or the renderer crashes mid-snapshot, Playwright throws `Target page, context or browser has been closed` (confirmed at `~/.opensrc/repos/github.com/microsoft/playwright/1.59.1/packages/playwright-core/src/client/errors.ts:31`), the awaited promise rejects, and the error bubbles out of `runOnce`. |
| `config/scripts/run-release-memory-benchmark.mjs:554`         | `cdpSession = await browser.contexts()[0].newCDPSession(page)`                                                                                                              | `browser` is bound only inside `connectToApp`'s return and is never `.close()`d. On the error path the playwright connection leaks too, keeping the page alive even after the kill.                                                                                                                                                                                                                         |
| `config/scripts/run-release-memory-benchmark.mjs:17`          | `DEFAULT_CDP_PORT = 9223` (fixed)                                                                                                                                           | No `pickFreePort()` even though one exists in the same package (`config/scripts/windows-apphang-repro/electron-dev-session.mjs:35-42`). On the second of six runs against the same path, the prior tree still owns 9223 → the next spawn fails CDP attach and the orphan stays resident.                                                                                                                    |
| `config/scripts/windows-apphang-repro/repro-timing.mjs:17-34` | `runWithTimeout` races `action` against a delay; `actionPromise.catch(() => undefined)` swallows the action's rejection if the timeout wins.                                | When `cdpSession.send` rejects, the `Promise.race` returns the timeout sentinel first (because the awaited CDP send can hang on a half-closed socket for >90s), the harness then throws "Timed out during …", and the original `Target page closed` rejection becomes an unhandled rejection that never reaches the runOnce `finally`.                                                                      |
| `config/scripts/run-release-memory-benchmark.mjs:639-642`     | `main().catch(error => { console.error(error); process.exit(1) })`                                                                                                          | After a `runOnce` throw, `process.exit(1)` is called immediately while the Electron tree rooted at the previous `child.pid` is still alive. No exit hook reap.                                                                                                                                                                                                                                              |

---

## Lifecycle trace: one leaked run

```
.auto/measure.sh
  → node config/scripts/run-release-memory-benchmark.mjs --ab CAND BASE --runs 3 ...
    → runOnce(A, runIndex=0)
      // spawns Orca.app/Contents/MacOS/Orca, detached:false, stdio:'ignore'
      // rootPid = child.pid (in Node's own pgid)
      // ps tree: harness(pid H) → orca(H) → orca-helper/--type=gpu-process
      //                                       → orca --type=renderer → node-pty → login → fetchCdpTargets(9223, 120_000)  // OK
      → connectToApp(9223)              // Playwright CDP attaches; cdpSession bound to renderer Page
      → takeHeapSnapshotSummary(cdpSession)  // OK at boot
      → applyFixture(...) → settle 30s → window 120s → externalSweep(rootPid)
      → takeHeapSnapshotSummary(cdpSession)  // CRASH: cdpSession.send throws
                                            //   "Target page, context or browser has been closed"
                                            //   (because renderer process was reaped or Page navigated)
      // bubble to runOnce.catch (none) → throw → finally reached
      finally {
        child.kill('SIGTERM')           // signal orca(H) only — gpu/renderer/utility children in same
                                       //   pgid as Node harness do NOT inherit it via group signal
        await sleep(250)                // give Electron 250ms to shut down — too short for GPU + relaunch
        if (child.exitCode === null) child.kill('SIGKILL')
        // again, only the main pid
        // ORPHANS: --type=gpu-process, --type=renderer, --type=utility,
        //   --type=zygote, login shells, any node-pty children
      }
      // throw propagates to main().catch
      main().catch(error => { console.error(error); process.exit(1) })
      // Node exits; harness has no 'exit' handler; OS does NOT SIGHUP
      //   detached children of detached:false processes — they're already
      //   in the Node harness's session but reparented to launchd on macOS
      //   the moment their parent dies, so they keep running.
      // .auto/measure.sh sees nonzero exit; depending on its bash `set -e` and the OS reparent behavior,
      //   the next .auto/measure.sh run picks up the same baseline app path → stale port + stale tree
    → runOnce(B, runIndex=1) spawns Orca again on port 9223 → EADDRINUSE-ish attach failure → repeat → ... up to 6 spawns total per measure.sh execution (A,B,B,A,A,B)
```

---

## Why the existing `finally` is not enough

Three independent defects combine to make it leaky:

1. **`child.kill` is root-only on POSIX.** The `runOnce` finally kills the Electron _main_ pid (`config/scripts/run-release-memory-benchmark.mjs:598`). Chromium's GPU process, renderer process, utility processes, the zygote, and any node-pty descendants are not children in the process-group sense of the main — they share the harness's pgid because `detached: false` was passed. A signal to the main Electron pid does not cascade to those siblings. The benchmark `idle-cpu-process-sampling.mjs:117-128` even classifies them by `--type=` flag, proving the harness knows they exist as a separate population.

2. **No signal handlers and no exit reap.** The harness registers no `process.on('SIGINT'|'SIGTERM'|'exit')` listener. The top-level `main().catch` exits the Node process the moment any `runOnce` rejects, but the Electron tree that `runOnce` just spawned is reparented to launchd on macOS the instant the harness dies (because `detached: false` keeps them in the Node session, and Node's exit tears that session down without SIGHUP propagation to non-direct-children). Confirmed: `run-electron-vite-dev.mjs:714-720` is the pattern this codebase already uses, and `serve-headless-fresh-profile-pairing.mjs:298-307` shows the right way to combine group-kill with try/catch.

3. **The `finally` is `await sleep(250)` then SIGKILL — not enough time, not enough reach.** 250 ms is shorter than the Chromium child shutdown grace period. And even if 250 ms were enough, the SIGTERM/SIGKILL pair only hits the root pid; it does not propagate. The sibling file `tests/tools/benchmarks/terminal-cold-park-resource-bench.mjs:425-440` documents this exact pitfall inline and patches around it with `execFileSync('pkill', ['-9', '-P', String(launched.child.pid)], …)`. The release-memory harness has neither the patch nor the comment.

The CDP crash makes this hit on every flaky run: `cdpSession.send` rejects mid-flight (verified against `playwright-core/src/client/errors.ts:31` and `cdpSession.ts:51`), the awaited call doesn't reach a clean teardown, the `finally` runs but kills only the root, and `runOnce` throws. The next iteration of the outer loop starts before the prior tree is gone — six trees in steady state.

---

## Suggested minimum fix

**Architecture (small, layered):**

1. **`config/scripts/run-release-memory-benchmark.mjs`** — the only file that needs real changes:
   - Spawn `detached: true` (POSIX) so the Electron tree becomes its own pgid leader. (`stdio: 'ignore'` already.)
   - Replace the root-only `child.kill('SIGTERM')`/`SIGKILL` in the `finally` with `process.kill(-child.pid, signal)` (POSIX) or `taskkill /pid <pid> /t /f` (win32, via `src/shared/child-process/process-tree-termination.ts:14-28` which already does this correctly and is what the rest of the main process uses).
   - Wrap `takeHeapSnapshotSummary(cdpSession)` calls and `applyFixture`'s `page.evaluate` blocks in `try/catch` so a closed target logs and degrades to `heapBoot=null`/`heapIdle=null` instead of throwing — `takeHeapSnapshotSummary` should `try { await cdpSession.send(...) } catch (error) { cdpSession.detach()?.catch(() => undefined); return null }`. With null summaries the `finally` still fires cleanly.
   - Always `await browser.close().catch(() => undefined)` before `child.kill`. This makes Playwright detach cleanly, which avoids the "target closed" error class in the first place.
   - Install `process.on('SIGINT')`, `process.on('SIGTERM')`, and `process.on('exit')` handlers that re-kill the current `child` via the group-signal helper. (Pattern: `config/scripts/run-electron-vite-dev.mjs:678-720`.)
   - Replace the fixed `DEFAULT_CDP_PORT = 9223` with `pickFreePort()` from `config/scripts/windows-apphang-repro/electron-dev-session.mjs:35-42` — this also makes A/B interleaving safe even if a previous run leaked.
   - Add a small `reapLeftovers` pre-run check (best-effort): if `pgrep -f <app-executable-name>` returns any pid whose `ps -o ppid=` is not us, log loudly and `pkill -9 -P` it before each `runOnce`. A `set -e`/non-zero exit on leftovers is what the host audit is asking for.

2. **`config/scripts/run-release-memory-benchmark.test.mjs`** — extend the unit tests (currently 248 lines, all helpers-only) to cover the new behavior:
   - Mock `spawn` and assert the harness passes `detached: true` on POSIX.
   - Mock a `runOnce` that throws inside `takeHeapSnapshotSummary` and assert the group kill is invoked.
   - Assert `process.on('SIGINT')` is registered.

3. **`config/scripts/idle-cpu-process-sampling.mjs:317-323`** — `terminateProcesses(processes)` is unused; either remove or expose as the shared helper the bench uses.

**Code shape (drop-in):**

```js
// config/scripts/run-release-memory-benchmark.mjs
import { signalProcessTree, forceTerminateProcessTree } from '../src/shared/child-process/process-tree-termination.ts'
// (or copy the 30-line pattern from serve-headless-fresh-profile-pairing.mjs if .ts import is undesirable)

const child = spawn(executable, args, { detached: process.platform !== 'win32', stdio: 'ignore', env: {...} })
let killed = false
async function killTree(signal) {
  if (killed) return
  killed = true
  await signalProcessTree(child, signal)        // group signal on POSIX, taskkill /T on win32
}
process.on('SIGINT',  () => { void killTree('SIGTERM').then(() => process.exit(130)) })
process.on('SIGTERM', () => { void killTree('SIGTERM').then(() => process.exit(143)) })

try { ... } finally {
  try { await browser?.close() } catch {}
  await killTree('SIGTERM')
  await new Promise(r => setTimeout(r, 500))
  if (child.exitCode === null) await killTree('SIGKILL')
  await forceTerminateProcessTree(child)        // hard backstop, ignores result
}
```

**Optional pre-run sweep** (loud failure, single function, ~10 lines):

```js
function reapLeftovers(executablePath) {
  if (process.platform === 'win32') return
  const marker = path.basename(executablePath)
  const pids = execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean)
  if (pids.length === 0) return
  console.warn(
    `[release-memory] reaping ${pids.length} leftover ${marker} processes from prior run`
  )
  for (const pid of pids) {
    try {
      process.kill(Number(pid), 'SIGKILL')
    } catch {}
  }
}
// at top of runOnce, before spawn:
reapLeftovers(appPath)
```

---

## Existing upstream issues / PRs

None directly. `gh issue list -R stablyai/orca -S 'release-memory benchmark leak orphan'` returned only unrelated closed issues (`#8013` huge-files renderer stall; `#7576` Performance Diagnostics spam). **The bug is unfiled** — we own first-filer.

The closest in-repo signal is the inline comment at `tests/tools/benchmarks/terminal-cold-park-resource-bench.mjs:430-440` (the same author's own admission that the bench stack under-reaps).

---

## Files in the repo that would change, ranked by risk

1. **`config/scripts/run-release-memory-benchmark.mjs`** — primary fix site (detached spawn, group kill, signal handlers, CDP try/catch, `pickFreePort`, pre-run sweep). Touches the bench invoked by `.auto/measure.sh`; risk = blocking the autoresearch loop until a re-baseline completes. Low correctness risk: changes are in the kill path; the artifact shape and metrics are untouched.
2. **`config/scripts/run-release-memory-benchmark.test.mjs`** — extend to assert new lifecycle; risk = trivial.
3. **`config/scripts/windows-apphang-repro/electron-dev-session.mjs`** — no change needed for the fix, but candidate for exposing `pickFreePort` and a `disposeBrowser(page)` helper that does `browser.close()` defensively. Risk = low; widely imported.
4. **`config/scripts/idle-cpu-process-sampling.mjs`** — optional: expose `terminateProcesses` as the shared reap helper, or delete it. Risk = low.
5. **`src/shared/child-process/process-tree-termination.ts`** — no change needed; this is the right helper to reuse. Mention in the PR so future contributors don't reinvent it (the allowlist at `src/shared/child-process/__fixtures__/child-process-import-allowlist.txt` is ratchet-tested).
6. **`config/scripts/run-electron-vite-dev.mjs`** — no change needed; this is the in-tree reference for the SIGINT/SIGTERM pattern that the benchmark should adopt.
7. **`.auto/measure.sh`** — staged, not committed; no change needed but worth a note that the pre-run sweep will make `set -euo pipefail` actually safe across iterations.

**Out-of-scope but adjacent:** `tests/tools/benchmarks/terminal-cold-park-resource-bench.mjs:425-440` already has a `pkill -9 -P` workaround; once the shared helper lands, that workaround should be replaced with the same group-signal pattern. Mention as follow-up.

---

## Positioning notes for the fork

- This is the most clearly our-bug of the three — it is a measurement bug in our own benchmark harness, no upstream users are affected. Land it as a local commit on the `memloop` lane first to drop the noise floor, then publish the upstream PR.
- The pre-run sweep also gives us a free loud-failure detector: future host-noise regressions will trip it on the first measure.sh invocation, instead of going unnoticed until someone runs an audit.
- Coordinate with research #1 (daemon leak) because both touch the `main-process` memory measurement path and both inflate the noise floor in the same way.
