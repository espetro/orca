# F4 / C8: renderer host-mirror replay buffer investigation

Date: 2026-08-29
Scope: `src/renderer/src/runtime/` (web-runtime-session.ts and neighbors).
Question: does the renderer accumulate host events for post-reconnect replay, and is that accumulation bounded?

## Findings table

| Item | Location | Bounded? | Cap | Worst-case retained |
|---|---|---|---|---|
| Replayable snapshot latch | `web-session-tabs-sync.ts:191` (`replayableSessionTabsSnapshotByWorktree`) | Yes (single record per key) | one `{publicationEpoch, snapshotVersion}` record per environment×worktree key; deleted on accept (`:692`), teardown (`:813`, `:842`) | bytes/key (two numbers), not snapshots |
| Latest accepted snapshot freshness | `web-session-tabs-sync.ts:190` (`latestSessionTabsSnapshotByWorktree`) | Yes (single per key) | keyed overwrite only | bytes/key |
| Latest received frame | `web-session-tabs-sync.ts:192,396` | Yes (single per key) | keyed overwrite | bytes/key |
| Pending snapshot fan-out | `web-session-terminal-handle-events.ts:18-24` (`pendingSnapshotBySession`) | Yes | one snapshot reference per session key, consumed in a microtask (`:100-111`) | one live host snapshot ref per session, same object the store already holds |
| Replay tag mechanism | `src/shared/runtime-subscription-replay.ts` | Yes | boolean flag on the response; no accumulation | 0 |
| Event stream replay | `runtime-client-events.ts:14-39` | Yes | no queue at all; comment states lost events are lost, replay only triggers a resync signal | 0 |

## Answers

1. **Is there a replay buffer?** No accumulating event buffer. Post-reconnect replay is handled by re-subscribing; the host re-emits each stream's current snapshot, and the client tags the first response (`runtime-subscription-replay.ts`) plus latches the last accepted snapshot identity (`replayableSessionTabsSnapshotByWorktree`) so the re-emitted snapshot passes monotonic-freshness gates instead of being dropped (#7718). None of these structures keep a list of events.
2. **Bounded?** All structures are `Map` keyed by `environmentId\u0000worktreeId` holding at most one small record (or one snapshot reference shared with the store) per key, with deletion paths on snapshot accept, per-worktree teardown, and per-environment teardown (`web-session-tabs-sync.ts:767-855`). Growth is bounded by the number of live environments × worktrees, which the app itself tracks in the store.
3. **Worst-case memory:** one `RuntimeMobileSessionTabsResult` reference per subscribed session key in `pendingSnapshotBySession` (transient, one microtask) — these reference snapshots already retained by the store, so marginal memory is ~zero. Freshness maps hold two integers per key. Worst case across, say, 50 worktrees: well under 1 MB total; no realistic path to growth with session duration.
4. **Fix needed?** No. No unbounded buffer found; no code changed.

## Recommendation

Close C8/F4 as not-a-defect. If a future change introduces per-event retention for replay, enforce a per-key cap constant then; nothing to cap today.

## Existing bounded-buffer patterns for reference

- `web-session-terminal-handle-events.ts:100` — microtask coalescing (only newest wins).
- `web-session-tabs-sync.ts:692` — delete-on-consume latch semantics.
- Host-side `runtime_rpc_queue_overloaded` error (`web-runtime-session.ts:141`) shows the transport layer rejects overload rather than buffering.
