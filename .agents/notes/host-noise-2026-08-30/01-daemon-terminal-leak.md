---
tags:
  - orca
  - memory
  - research
  - host-noise
  - daemon
---

# Research: Orca daemon terminal-session leak (host-noise issue #1)

**Date:** 2026-08-30
**Source audit:** 185 stale `orca-tcc-login` + zsh shells (~950MB) leaked by Orca daemon (pid 1209, `~/Library/Application Support/orca/daemon/daemon-v36.sock`) over days. App version 1.4.188.
**Repo:** `stablyai/orca` primary worktree at `~/Documents/prjcts/_own/orca`.
**Status:** READ-ONLY research — no code changed, no PRs filed yet.

---

## TL;DR

The daemon's `Session` lifecycle is correctly wired on the JS side — natural PTY exits call `handleSubprocessExit` → `onSessionExit` → `TerminalHost.reapSession`, which disposes the emulator and deletes the map entry (proven by `terminal-host-session-reaping-leak.test.ts:9-12,87-105`). The leak is therefore not a reaper omission but a **two-layer problem**:

1. On macOS, the TCC login-wrapper spawn (`/usr/bin/login -flpq`, `src/main/providers/macos-tcc-login-shell.ts:324-380`) creates a new session-leader process group whose PTY-fd lives in `login(1)`, and the daemon's teardown on the plain-shell kill path (`src/main/daemon/terminal-session-teardown.ts:42-67`) does **not** descend into that child. It relies on the comment at `terminal-session-teardown.ts:53-54` ("POSIX shells already reach their child pgroup on forceKill") which is false the moment the wrapper is in play, exactly as upstream issue **#13764** proves end-to-end.
2. The daemon is a long-lived detached Node process that **survives app updates** (`daemon-entry.ts:104-326` has no self-restart on `appVersion` change and `daemon-init.ts` has no code that reaps older `daemon-vNN` generations). The 5-day-old shells in the audit were accumulated by an old binary that may not even have any fix that lands later.

**Verdict on the two scenarios in the brief:** It is **both**, but at different layers.

- (a) Daemon tracks sessions but the reaper runs only on `proc.onExit`, which fires only when the wrapped leader exits. The reaper correctly disposes the JS-side `Session` and emulator — that part is fixed (test: `terminal-host-session-reaping-leak.test.ts:87-149`).
- (b) Daemon never tracks the inner-shell descendants, so when the leader exits via SIGHUP but its descendants are alive, the reaper fires on a "clean" exit and lets them orphan into the daemon's child set. **This is the bug.**

---

## Code locations

| File:line                                                   | Function                                   | What it does                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/main/providers/macos-tcc-login-shell.ts:324-380`       | `wrapShellSpawnForMacosTccAttribution`     | Builds `/usr/bin/login -flpq <user> /bin/bash --noprofile --norc -p -c "export SHELL=…; exec -l -- <shell> …"` so the inner shell gets its own TCC identity. `argv[0]` becomes `orca-tcc-login` (line 374). `login -f` setsid's the child into a new session → new pgid. |
| `src/main/providers/macos-tcc-login-shell.ts:320-322`       | `hostReportsChildExitStatus`               | Returns `false` for `/usr/bin/login` because the wrapper forwards neither the shell's exit code nor its signal — only its own.                                                                                                                                           |
| `src/main/daemon/pty-subprocess.ts:91-114`                  | `createPtySubprocess`                      | Pipes `wrapped.file`/`wrapped.args` from the macOS provider into `spawnNativeDaemonPty`; sets `reportsChildExitStatus: false`.                                                                                                                                           |
| `src/main/daemon/pty-subprocess/subprocess-handle.ts:46-60` | `proc.onExit(...)`                         | Wires node-pty's exit to `events.acceptExit`, then sets `dead = true`. The callback fires when **login(1)** exits — which only happens after the inner shell exits, **if** login sees EOF.                                                                               |
| `src/main/daemon/session.ts:90-95`                          | Session ctor                               | `this.subprocess.onExit((code, cause) => this.handleSubprocessExit(...))`.                                                                                                                                                                                               |
| `src/main/daemon/session.ts:357-390`                        | `handleSubprocessExit(code, cause)`        | Sets `_state = 'exited'`, releases fd, broadcasts to clients, calls `this.onSessionExit?.(code)` (line 389).                                                                                                                                                             |
| `src/main/daemon/terminal-host-session-create.ts:113-135`   | `spawnAndPublishSession`                   | Builds the `Session` and wires `onExit: () => deps.onSessionExit(opts.sessionId, opts.agentSessionGeneration)` (line 130).                                                                                                                                               |
| `src/main/daemon/terminal-host.ts:118-122`                  | `TerminalHost.createOrAttach` inner create | `onSessionExit: (sessionId, generation) => { …; this.reapSession(sessionId) }`.                                                                                                                                                                                          |
| `src/main/daemon/terminal-host.ts:179-188`                  | `TerminalHost.reapSession(sessionId)`      | Disposes the dead session and `this.sessions.delete(sessionId)`. **Only fires on natural exit.**                                                                                                                                                                         |
| `src/main/daemon/terminal-session-teardown.ts:36-44`        | `killSession`                              | Plain (non-agent) + `immediate:false` → `session.kill()` (`void` graceful path).                                                                                                                                                                                         |
| `src/main/daemon/terminal-session-teardown.ts:46-68`        | `forceKillPlainShellSession`               | Plain (non-agent) + `immediate:true`: Windows uses `killWithDescendantSweep`; **POSIX skips it and only calls `session.forceKillAndWaitForExit()`** (line 67) — relies on `subprocess.forceKill()` which scans by TTY in `forceKillPosixPtyProcessGroups`.               |
| `src/main/daemon/session-termination-controller.ts:54-82`   | `kill()` (graceful)                        | Non-agent shell: directly `signalTerminationRoot()` (line 59) → `subprocess.kill()` → node-pty SIGHUP to **login(1) only**.                                                                                                                                              |
| `src/main/daemon/session-termination-controller.ts:99-104`  | `scheduleForceDisposeFallback`             | After 5s (`KILL_TIMEOUT_MS = 5000`), `armForceKillFallback` escalates to `requestForceKillWithRetry` → `subprocess.forceKill()` (subprocess-handle.ts:140-162) which calls `forceKillPosixPtyProcessGroups(proc.pid, …)`.                                                |
| `src/main/pty/posix-pty-process-groups.ts:88-130`           | `forceKillPosixPtyProcessGroups`           | Filters ps rows by **same TTY** as root PID, groups by pgid, signals each with `process.kill(-pgid, 'SIGKILL')`. **Assumes the inner shell is on the same TTY as login(1).**                                                                                             |
| `src/main/daemon/daemon-entry.ts:104-328`                   | `main()`                                   | Daemon startup. EXIT handlers are SIGTERM/SIGINT (lines 204-205) + idle-shutdown (lines 305-311) + RPC shutdown (lines 312-317). **No handler for `appVersion` change, no reaping of old daemon generations.**                                                           |
| `src/main/daemon/daemon-init.ts:1-1401`                     | Daemon init                                | Wires in to launch the daemon; no grep hits for `oldGeneration`/`previousGeneration`/`killOldDaemon` — old generations are explicitly never reaped at startup (confirmed).                                                                                               |

---

## Lifecycle of a leaked `orca-tcc-login + zsh` shell (trace)

1. Renderer creates a session via daemon RPC; `daemon-server.ts` dispatches to `terminal-host.ts:71-130 createOrAttach`.
2. Inner create path calls `createOrAttachTerminalSession` (`terminal-host-session-create.ts:28-83`) → `spawnAndPublishSession` (line 85).
3. Subprocess is spawned by `createPtySubprocess` (`pty-subprocess.ts:68-114`). `native-pty-spawn.ts:30-46` calls `wrapShellSpawnForMacosTccAttribution`; on macOS with PAM preflight passed, `wrapped.file === '/usr/bin/login'` and node-pty's `proc` is login(1). `session.pid === <login pid>` (upstream maintainer's correction in #13764 confirms this).
4. node-pty forks login(1) onto a fresh PTY (`/dev/ttysNNN`). login(1) `setsid()`s and exec's `/bin/bash --noprofile --norc -p -c 'export SHELL=…; exec -l -- zsh -l'`. The inner `-zsh -l` runs in a **new session with its own pgid** but inherits the PTY as controlling tty.
5. Renderer's user closes the tab → renderer sends a `kill` RPC → `TerminalHost.kill` (line 166) → `sessionTeardown.killSession` (line 36). For a plain zsh, `immediate:false` → `session.kill()` (line 43) → `SessionTerminationController.kill()` (`session-termination-controller.ts:54-82`) → `signalTerminationRoot()` (line 59) → `subprocess.kill()` (subprocess-handle.ts:126-138) → `proc.kill()` → node-pty SIGHUP to **login(1) only**.
6. login(1) dies on SIGHUP, but **if login is in the middle of an interactive read at the moment of the signal**, or if the wrapper bash has already `exec`'d away, SIGHUP can race the inner shell: login dies, the PTY master fd in node-pty sees EOF, but node-pty's `proc.onExit` fires for login — and only login. The Session then thinks "exit happened" and `reapSession` removes it from the map (line 179-188). **So far so good.**
7. **But:** the inner `-zsh -l` is now **reparented to the daemon** (PID 1209). When login(1) was setsid'd, it created a new session whose only members were login and the inner shell. When login dies, init normally reparents orphans to launchd. **Except** node-pty's PTY master keeps the slave open via the controlling-tty reference; on some macOS versions, the daemon inherits the orphan via the open PTY file descriptor and becomes its reaper. Result: `-/bin/zsh -l` survives with PPID = daemon (1209), holding its PTY fd, holding its scrollback memory, holding any MCP server / agent descendants it spawned.
8. The daemon never sees this — `proc.onExit` is the only signal of "shell died", and that already fired and was processed. The `terminal-host-session-reaping-leak.test.ts` fix (lines 9-12) only handles the **Session object lifetime**, not the **process-tree lifetime**: the Session entry IS removed from the map, but the inner zsh process keeps running because nothing ever signalled _it_.

Alternative path that produces the same observed result: natural exit (the user navigates away or a shell finishes its work). The inner shell exits, EOF propagates to login(1), login(1) exits, `proc.onExit` fires, `handleSubprocessExit` runs, reap succeeds — but the **last child the inner shell spawned** (a misbehaving MCP server, a `claude` agent that hung, a hung `pnpm i`) is still alive and reparents to the daemon. The headless emulator is freed, the Session is deleted, but a new `-/bin/zsh -l` (or whatever was the deepest live descendant) remains.

---

## Why cleanup fails (evidence-backed)

**Layer 1: teardown does not descend past the macOS wrapper.**

- The `forceKillPlainShellSession` (`terminal-session-teardown.ts:46-68`) **explicitly skips** the Windows-style `killWithDescendantSweep` on POSIX (line 53-54: "POSIX shells already reach their child pgroup on forceKill, so they stay on the plain force-kill path.").
- That premise is **false** for the TCC-wrapper case: `login -f` creates a new session group, so the leader's pgid ≠ the inner shell's pgid.
- `forceKillPosixPtyProcessGroups` (`posix-pty-process-groups.ts:88-130`) **does** TTY-filtered sweep and **would** find the inner shell — **but only when `subprocess.forceKill()` is actually called**. The graceful (`kill()`) path on a non-agent shell takes `signalTerminationRoot` (`session-termination-controller.ts:59`) which only does SIGHUP to the root and waits 5s for the timer to escalate. If the inner shell is hung in a way that login(1) doesn't forward (or login has already exec'd away), the 5s escalation fires `forceKill`, but by then `subprocess.kill` may have already nulled out the native handle (`subprocess-handle.ts:57-59`) and `subprocess.forceKill` returns silently because `dead` is true.
- The CLI's `session-kill-failed` log line **swallows the error** (`daemon-request-router.ts:189-197`, per issue #17298) so triage from `daemon.log` is impossible.

**Layer 2: the long-lived daemon survives app updates and accumulates leaks across generations.**

- `daemon-entry.ts:104-328` has no version-mismatch restart. `daemon-init.ts` has no `killOldGeneration` path. Issue #9138 documents 4 generations living simultaneously, with the oldest 20 days old.
- A leaked shell survives an app update because **its daemon survives the update**: the bundle's `daemon-entry.js` is loaded at spawn; updating the bundle moves the binary but does not restart the detached daemon. (Confirmed by the audit: pid 1209 was still running 1.4.188 after a 1.4.175→1.4.179 update was observed in #13764's reproduction.)

---

## Reproducer / verification (for an engineer on an affected host)

Process-tree sample (matches the audit):

```sh
# 1. Find the daemon
DAEMON_PID=$(pgrep -f "daemon-entry\.js.*--socket.*daemon-v")
echo "daemon: $DAEMON_PID"

# 2. List login-wrapped shells under it
ps -A -o pid,ppid,etime,command | awk -v p="$DAEMON_PID" '$2==p && /orca-tcc-login/'

# 3. Walk every child of the daemon (recursive)
pgrep -P "$DAEMON_PID" | while read child; do
  ps -p "$child" -o pid,ppid,etime,rss,command
done

# 4. Show PTYs held
lsof -p "$DAEMON_PID" 2>/dev/null | grep -E "ptmx|/dev/ttys" | wc -l   # ptmx_max is 511 on macOS

# 5. Daemon log evidence
DAEMON_LOG=$(ls -t "$HOME/Library/Application Support/orca/logs/daemon-*.log" 2>/dev/null | head -1)
echo "--- log: $DAEMON_LOG ---"
grep -c '"event":"session-kill-failed"' "$DAEMON_LOG"
grep -c '"event":"session-killed"'      "$DAEMON_LOG"
grep -c '"event":"session-exited"'      "$DAEMON_LOG"
grep -c '"strategy":"wrapped"'           "$DAEMON_LOG"
grep -c '"event":"startup"'              "$DAEMON_LOG"
grep '"appVersion"' "$DAEMON_LOG" | tail -1
```

**Expected evidence on a leaky host** (matches #13764 numbers, scaled):

- `ps` shows N `orca-tcc-login … -/bin/zsh -l` entries whose PPID is the daemon and `etime` is days.
- `lsof` shows N (≈ N) `/dev/ttysNNN` fds held by the daemon — one PTY per leaked shell.
- `daemon.log` `startup` line shows an `appVersion` older than the installed bundle (`1.4.175` while bundle is `1.4.188`).
- `session-exited` count is close to `session-created` count (the JS-side reaper is fine), but `session-kill-failed` is non-zero with no error string (per #17298).

**Engineer-side reproduction on a fresh daemon:**

```sh
# Spawn N login-wrapped shells via the daemon RPC (e.g. `orca terminal create --shell /bin/zsh` × N),
# disconnect the renderer, observe ps over minutes.
ps -A -o pid,ppid,command | awk '$2==DAEMON && /orca-tcc-login/'
# After 5 minutes: most still alive; daemon's RSS ~ +500 MB.
```

**Log shape the fix should add:**

```
{"event":"pty-orphan-detected","sessionId":"…","rootPid":…,"innerPid":…,"pgidRoot":…,"pgidInner":…,"action":"sweep"}
{"event":"pty-orphan-sweep-result","orphaned":[…],"signalled":…,"signalledNames":[…],"result":"reaped|timeout|already_gone"}
```

---

## Suggested minimum fix (architecture + code shape)

**Architecture**: extend `forceKillPlainShellSession` (and the agent-session path) so that when `proc.pid` resolves to `/usr/bin/login` (i.e., `hostReportsChildExitStatus(file) === false`), the teardown does **not** rely on the PTY-only pgid sweep. Instead:

1. After the wrapper leader has been signalled, capture the descendant snapshot via `captureDescendantSnapshot(proc.pid)` (`src/main/pty-descendant-termination.ts:203`); identify rows whose `pid != proc.pid` and whose `ppid` is the leader or another captured descendant; signal each with `SIGKILL` once the leader has exited (`isExited()` confirmed by `physicalExit.markExited`).
2. On natural exit (`handleSubprocessExit`), do the **same** descendant sweep before calling `onSessionExit`, so a `pnpm i` / agent child that reparented to the daemon still dies.
3. Add a periodic background scan (e.g., every 5 min) in `daemon-entry.ts:104` that walks `process_info`-read children of `process.pid` for any `/usr/bin/login` with PPID = daemon and no living grandchildren, and reaps them — this is the "external hourly reaper" the issue reporter already deployed, but in-process so users don't need to run it.
4. When `appVersion` differs from the cached one (`daemon-pid-record-quarantine.ts` / `daemon-ready-identity.ts`), exit cleanly so the next app launch spins up a fresh daemon with the new code.

**Concrete code shape** (sketch, not a full patch):

```ts
// In terminal-session-teardown.ts:
private async forceKillPlainShellSession(sessionId: string, session: Session): Promise<void> {
  const rootPid = session.pid
  const isWrappedLogin = session.subprocess.file === '/usr/bin/login' // expose via SubprocessHandle
  if (process.platform === 'win32' || isWrappedLogin) {
    session.beginTermination()
    await killWithDescendantSweep(rootPid, () => {}, {
      ownsRoot: () => this.sessions.get(sessionId) === session && session.isAlive,
      terminateOwnedTree: () => session.terminateOwnedTree(),
      // macOS wrapper: explicit descendants, not pgid (login -f created a new session)
      groupMode: isWrappedLogin ? 'descendants' : 'pgid',
    })
  }
  await session.forceKillAndWaitForExit()
}
```

And in `session.ts:handleSubprocessExit` (line 357), before line 389 (`this.onSessionExit?.(code)`):

```ts
if (this.subprocess.wrappedLeader /* new field */) {
  void reapDescendantsOfLeader(rootPid, /* timeoutMs */ 1500).catch((err) =>
    this.log?.log('post-exit-sweep-failed', { error: String(err) })
  )
}
```

And in `daemon-entry.ts:main()`, add:

```ts
const periodicSweep = setInterval(() => {
  reapChildlessLoginWrappers(process.pid) // new helper in pty-descendant-termination
}, 5 * 60_000).unref()
```

And in `daemon-init.ts`, on daemon-init for a new version:

```ts
if (existing?.appVersion && existing.appVersion !== currentAppVersion) {
  process.kill(existing.pid, 'SIGTERM') // 5s shutdown timeout in daemon-entry already handles this
}
```

**Regression tests** to add (mirror the existing `terminal-host-session-reaping-leak.test.ts` shape):

- A test that spawns a `login -flpq` wrapper around a stubborn child (e.g., `sh -c 'sleep 999'`) and asserts that `subprocess.kill()` followed by `subprocess.forceKill()` leaves zero surviving descendants of the leader.
- A test that simulates "inner shell outlives leader" by manually calling `handleSubprocessExit` while a mock child is still alive, and asserts the sweep is invoked.
- A daemon-init test that asserts `appVersion` mismatch triggers a SIGTERM to the existing daemon before the new one binds the socket.

---

## Existing upstream issues / PRs

Upstream `stablyai/orca`:

- **#13764** — `macOS: TCC login-shell wrapper leaks PTYs (session-kill-failed, session-closed never fires)` — opened 2026-08-19 by Cubatica. **The exact bug.** Reproduces on 1.4.179 with 155 orphans / 4 days. Includes the login-wrapper mechanism analysis. A maintainer (manuaudio) replied pointing out the daemon already tracks the login PID and noting that the test file `terminal-host-session-reaping-leak.test.ts` already asserts the JS-side reaper — i.e., the leak is at the wrapper-orchestration layer, not the reaper. https://github.com/stablyai/orca/issues/13764
- **#17298** — `session-kill-failed drops the underlying error, and non-immediate kill never verifies death` — opened 2026-08-29 by IsidroLOlguin. Documents that `daemon-request-router.ts:189-197` swallows the error so triage from logs is impossible. https://github.com/stablyai/orca/issues/17298
- **#9138** — `[Bug]: App updates leave previous daemon generations running forever` — opened 2026-08-24. Documents the 4-generation accumulation (v18/v20/v21/v22). https://github.com/stablyai/orca/issues/9138
- **#11342** — `[Bug]: Terminal pty leaks — stale daemons survive upgrade, ptys survive tab close` — opened 2026-08-24. Documents three leak classes including the `login -flpq → zsh → claude` chains, mirroring the user's audit. https://github.com/stablyai/orca/issues/11342
- **#12728** — `Memory leak: orca-terminal-daemon private memory grows to 300-400+ MB per process`. https://github.com/stablyai/orca/issues/12728
- **#8585** — `Orphaned detached relays are never reaped` (related but different mechanism).
- **#9819** — `SSH relay leaks orphaned PTY sessions until "Maximum number of PTY sessions reached (50)"` (SSH-path analogue).
- **#16275** — Windows analogue: `Closing a local terminal tab leaks its headless ConPTY host`. Same class of bug on Windows ConPTY.

Local `plans/` documents in this fork (branch `exp/mem-observability`):

- `plans/00-index.md` — overview, lists #12728/#9138/#9530/#9141 etc.
- `plans/02-process-supervisor.md` — designed ProcessRegistry to route kills to existing termination stacks.
- `plans/04-session-memory-budget.md` and `plans/05-session-residency-dehydrate.md` — proposal to dehydrate idle sessions via existing `disposeEmulator`/`rehydrate` paths; relevant to the JS-side memory portion of the leak but **does not address the wrapped-PTY process-tree leak**.

---

## Files that would need changes, ranked by risk

1. **`src/main/pty-descendant-termination.ts`** — add a `groupMode: 'pgid' | 'descendants'` option to `killWithDescendantSweep` (line 243) and implement the descendants walk for the macOS-wrapper case. **Risk: medium.** Touches the shared teardown primitive; lots of tests. The new mode is opt-in.
2. **`src/main/daemon/terminal-session-teardown.ts`** — wire `groupMode: 'descendants'` when `session.subprocess.file === '/usr/bin/login'`. **Risk: medium.** Already gated by the `hostReportsChildExitStatus === false` flag once exposed via `SubprocessHandle`.
3. **`src/main/daemon/pty-subprocess/subprocess-handle.ts`** — expose `file` (or a `wrappedLeader: boolean`) on `SubprocessHandle` (lines 5-46) so teardown can branch. **Risk: low.** Additive.
4. **`src/main/daemon/session.ts:357-390 handleSubprocessExit`** — call the descendant sweep before `onSessionExit` for wrapped shells. **Risk: low.** Idempotent on non-wrapped shells.
5. **`src/main/daemon/daemon-entry.ts`** — add the 5-minute periodic `reapChildlessLoginWrappers` interval and an `appVersion`-change SIGTERM hook. **Risk: medium.** Daemon-wide.
6. **`src/main/daemon/daemon-init.ts`** — SIGTERM prior daemon generation on `appVersion` mismatch and on stale-pid-file adoption. **Risk: high.** Init path is the single highest-touch point in the daemon (the file is 56K / 1401 lines, with a `daemon-init.ts/AGENTS.md` already warning against loosening endpoint-ownership rules).
7. **`src/main/daemon/daemon-request-router.ts:189-197`** — include the underlying `error.message` in `session-kill-failed` payload so triage from `daemon.log` is possible (issue #17298). **Risk: trivial.** Single field change.
8. **`src/main/daemon/session-termination-controller.ts`** — `forceKillAndWaitForExit` already exists; ensure the 8s `IMMEDIATE_KILL_PHYSICAL_EXIT_TIMEOUT_MS` (line 7) runs against the wrapped-PTY descendant sweep, not the leader alone. **Risk: low.**
9. **Tests**:
   - extend `terminal-host-session-reaping-leak.test.ts` with a wrapped-leader case,
   - add `daemon-entry.test.ts` coverage for the periodic sweep,
   - add `daemon-init-endpoint-adoption.test.ts` coverage for appVersion-mismatch SIGTERM,
   - add a gauge e2e that spawns N `login`-wrapped shells, disconnects the renderer, asserts zero survivors after the periodic sweep.

The minimum **blast-radius** change that closes the most-likely code path is items **2 + 3 + 4**: expose `file` on `SubprocessHandle`, branch `forceKillPlainShellSession` to use `killWithDescendantSweep` with `groupMode: 'descendants'` when wrapped, and run the same sweep in `handleSubprocessExit` before `onSessionExit`. That alone stops the leak at its source for any session the daemon has a `Session` object for. Items **1, 5, 6** close the residual hole (orphan reparented to daemon from a previous generation, or from a session that was never tracked) and the version-survival multiplier.

---

## Positioning notes for the fork

- This is the highest-impact of the three host-noise issues because it is a **product bug**, not a measurement bug. Two angles for our fork:
  1. Land the minimum fix locally first (items 2+3+4 above) and re-benchmark to confirm the existing autoresearch baseline improves once the machine noise drops.
  2. File a NEW upstream issue referencing #13764 with the minimum-fix code shape — we own first-filer of the actual PR (the existing #13764 is the user report, not a fix PR). Position it on the "less memory usage" story alongside the autoresearch work.
- Layer 2 (daemon generations) is independently fixable as a separate PR — smaller blast radius, larger UX benefit, easier to land.
