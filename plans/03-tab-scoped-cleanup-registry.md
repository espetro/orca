# Tab-scoped cleanup registry for renderer keyed state

## Problem

Renderer modules keep per-tab and per-worktree state in module-scoped `Map`s keyed by
`tabId` / `worktreeId`, with no owner responsible for deleting entries when the tab closes. Tab
teardown exists only as a hand-written scrub of a fixed list of store keys, so any registry
outside that list leaks an entry per closed tab for the life of the session.

## Evidence

Ten module-scoped keyed registries with no release path on tab close:

- `src/renderer/src/components/terminal-pane/terminal-pane-recovery.ts:70-73`: three collections
  (`recoveryTimestampsByTabId`, `recoveryGenerationByTabId`, `pendingRetryByTabId`) plus a
  sibling Set.
- `src/renderer/src/components/terminal-pane/terminal-pane-attention-subscriptions.ts:9`
  (`listenersByTabId`)
- `src/renderer/src/components/terminal-pane/terminal-input-quarantine.ts:33`
  (`quarantineByTabId`)
- `src/renderer/src/components/terminal-pane/terminal-parked-watcher-registry.ts:30,55`
- `src/renderer/src/components/browser-pane/describe-page/live-browser-url-registry.ts:1`
  (`liveBrowserUrlByTabId`)
- `src/renderer/src/lib/parked-terminal-host-hydration.ts:10`
  (`parkedTabIdsByWorktreeId`)
- `src/renderer/src/lib/pane-manager/client-hosted-browser-row-state.ts:27`
  (`rowsByWorktreeId`)
- `src/renderer/src/lib/source-control-huge-repo-warning-dismissals.ts:22`
  (`hugeRepoWarningStateByWorktreeId`)
- `src/renderer/src/components/sidebar/worktree-card-agents-expansion-state.ts:30`
  (`expansionByWorktreeId`)

Tab teardown is manual: `src/renderer/src/store/terminals/terminal-tab-close.ts:99-115` deletes
roughly 15 `*ByTabId` store keys one by one (`expandedPaneByTabId`, `ptyIdsByTabId`,
`runtimePaneTitlesByTabId`, `directSshPaneRetryByTabId`, and more). Every new keyed store field
requires remembering to extend this list.

There is no central tab-destroyed event that non-store modules can subscribe to. Lint coverage
does not catch this either: `config/oxlint-react-doctor.json` enables 12 rules, none of which
detect unowned keyed registries.

The leak class is user-visible: `recoveryTimestampsByTabId` growth was reported in issue #15241.

## Design

New module, e.g. `src/renderer/src/lib/tab-scoped-cleanup.ts`:

```ts
export function registerTabScopedCleanup(
  tabId: string,
  dispose: () => void
): () => void  // returns unregister
```

A single emitter lives at the tab-close action factory (`createTerminalTabCloseActions` in
`src/renderer/src/store/terminals/terminal-tab-close.ts`). On close it fires the destroyed event,
which runs all registered disposables for that `tabId` and then clears them. Worktree-keyed
registries register under the tab ids they own, or subscribe to worktree teardown if one exists.

Migration of the 10 registries happens in one PR: each module replaces direct map writes with
registry calls, or keeps its map and registers a `dispose` that deletes its key. Behavior is
unchanged for live tabs.

Second PR: lint rule banning new module-level `*By(Tab|Leaf|Session|Worktree)Id` Maps outside an
allowlist, so the pattern cannot regrow silently. Implemented as an oxlint plugin in
`config/oxlint-plugins/` (four plugins already exist there as templates).

## YAGNI

- No `WeakRef` / `FinalizationRegistry` magic. Tab close is a deterministic event we already
  control; GC-based reaping would reintroduce the nondeterminism this doc removes.
- No store restructuring. The hand-scrub in `terminal-tab-close.ts` can stay; the registry is
  additive and covers state that lives outside the store.

## Measurement

Heap snapshot of the renderer after opening and closing 50 tabs, comparing `Map` entry counts for
the 10 registries before and after: before shows residual entries proportional to tabs closed,
after shows zero.

Simpler CI-enforceable proxy: count of keyed registries with guaranteed release goes 0/10 to
10/10, and the lint rule blocks any 11th unowned registry.

## Effort

M for the migration (10 modules plus the emitter), S for the lint rule. Ship as separate PRs.

## Tests

Module-local only, anchored on existing suites:

- `terminal-pane-recovery.test.ts` extended to assert recovery state is gone after close
- `terminal-tab-close-tombstone.test.ts` extended to assert the emitter fires before tombstone
  finalization
- one new test per migrated registry asserting dispose ran on tab close

## PR split

1. Registry module + emitter + migration of all 10 registries + tests.
2. Oxlint rule + allowlist + rule test.
