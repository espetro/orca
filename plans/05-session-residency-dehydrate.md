# Session Residency: Dehydrate Background Sessions in the Daemon

Status: draft, for review by daemon maintainers (Neil)
Area: `src/main/daemon`
Effort: M

## SMART goals

1. Add an explicit residency state machine to daemon terminal sessions, landed behind `DAEMON_SESSION_DEHYDRATE_IDLE_MS` (default off), reviewable in one PR.
2. On a machine with 10 background sessions open for 30 minutes, reduce daemon private commit by at least the size of the disposed emulators' scrollback (measured via the plan below).
3. Zero data loss: every dehydrate is preceded by a successful checkpoint; attach after dehydrate restores seed content identical to a fresh daemon restart today.
4. No change to the checkpoint file format or the cold-restore payload contract.

## Problem

The daemon keeps a full `HeadlessEmulator` per session for the lifetime of the process, even for sessions no client is attached to. A long-lived daemon with many stale sessions accumulates hundreds of MB of private commit that no user can see.

## Evidence

Issue #12728: a single daemon sits at 300 to 400 MB private commit in steady state; a user with three daemons observed 1.08 GB across them. The dominant term is retained scrollback.

Each live session holds up to five copies of scrollback:

| Copy                       | Where                                                                                                 | Cap                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Grid + scrollback          | `HeadlessEmulator` in daemon, constructed per session at `src/main/daemon/session-output-plane.ts:49` | up to 50k rows (`DESKTOP_TERMINAL_SCROLLBACK_ROWS_MAX`, `src/shared/terminal-scrollback-policy.ts:3`) |
| Pending output records     | session-output-plane, `src/main/daemon/session-output-plane.ts:16`                                    | 2 MB                                                                                                  |
| Cold restore payload cache | `src/main/daemon/cold-restore-payload-cache.ts:14`                                                    | 16 MB                                                                                                 |
| Disk checkpoint            | `TERMINAL_HISTORY_CHECKPOINT_MAX_BYTES`, `src/main/daemon/terminal-history-file-limits.ts:5`          | 200 MB                                                                                                |
| Renderer xterm buffer      | renderer process                                                                                      | user-configured scrollback                                                                            |

Reclaim is currently possible only when the PTY process dies: `reapSession` runs exclusively on death (`src/main/daemon/terminal-host.ts:178`). A background session whose shell is alive but idle pins its emulator forever.

## Existing primitives (this PR composes, does not invent)

- `disposeEmulator()` / `markDisposed()` on the session record, `src/main/daemon/session-output-plane.ts:270-276`.
- Restore depth policy knob: `DAEMON_RESTORE_SCROLLBACK_ROWS`, `src/main/daemon/daemon-restore-scrollback-depth.ts:5`.
- Dirty-gated checkpoint scheduler on a 5s timer, `src/main/daemon/daemon-pty-checkpoint-scheduler.ts:33`.
- Rehydrate seed path: `historySeedChunks` written via `writeSync` before listener registration, `src/main/daemon/session-output-plane.ts:63-66`.
- Checkpoint reader for restore: `src/main/daemon/terminal-history-checkpoint-reader.ts`.

## Proposed design

Attach a residency enum to each session:

```
attached -> detached-hydrated -> dehydrated -> reaped
```

- `attached`: one or more `AttachedClient`s (existing behavior).
- `detached-hydrated`: no clients, emulator resident. Today every background session lives here forever.
- `dehydrated`: emulator disposed, seed content checkpointed. The session remains in the sessions map so attach, signal, and snapshot still route correctly.
- `reaped`: existing `reapSession` path on process death.

Policy trigger: a session transitions `detached-hydrated -> dehydrated` when all of these hold:

1. `hasAttachedClients` is false (`session-output-plane.ts:38`).
2. Last detach time exceeded `DAEMON_SESSION_DEHYDRATE_IDLE_MS`.
3. The dirty-gated scheduler reports the session checkpointed (no pending dirty window), so `disposeEmulator()` loses nothing not already on disk.

Lazy rehydrate on attach: on `attachClient` of a `dehydrated` session, the host rebuilds a `HeadlessEmulator` seeded from the checkpoint reader through the existing `historySeedChunks` path, then transitions to `attached`. This is the same seed path a fresh daemon attach uses today, so replay and responder rules are unchanged.

The poll piggybacks on the existing checkpoint scheduler tick rather than adding a timer.

## YAGNI (deliberately not in this PR)

- No lazy-materialized grid (recreating the emulator on demand inside the renderer): seed-from-checkpoint already exists and is tested.
- No per-daemon memory budget or LRU eviction: residency is per-session and idle-driven only.
- No partial dehydration (trimming scrollback rows in place): all-or-nothing dispose is simpler and matches `disposeEmulator` semantics.
- No renderer-side changes.

## SRP note

This PR only adds residency transitions and the idle policy in the daemon. It does not touch the checkpoint format, `terminal-history-file-limits.ts`, the cold-restore payload cache, or any IPC contract. If rehydrate-on-attach needs a new host message field, that is the single allowed cross-layer touch and should be flagged in review.

## Measurement plan

- Baseline and after: daemon private commit sampled every 30s over 60 minutes with N = 1, 5, 10, 20 background (detached) sessions, on macOS and Windows. Compare area under the curve.
- Functional: attach after 24h dehydrated must render identical content to baseline; measured by snapshot diff.
- Tests to extend (module-local only, no cross-package fixtures):
  - `src/main/daemon/terminal-host.test.ts`: residency transitions, attach-triggered rehydrate.
  - `src/main/daemon/daemon-restore-scrollback-depth.test.ts`: seed depth applied on rehydrate.
  - `src/main/daemon/terminal-history-large-checkpoint-cold-restore.test.ts`: dehydrate after large checkpoint round-trips.

## Risk and rollback

- Feature flag `DAEMON_SESSION_DEHYDRATE_IDLE_MS`, unset disables the state machine entirely (no poll, no dispose), so rollback is config-only.
- Main risk: a dehydrate racing an attach. Mitigated by transitioning inside the existing client-attachment critical section and re-checking `hasAttachedClients` immediately before `disposeEmulator()`.
- Second risk: a checkpoint that silently failed leaves dehydrate losing data. The trigger requires checkpointed state, and the dirty-gate already tracks write success.
