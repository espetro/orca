# Shared `withDir` opendir scope helper and oxlint import-boundary rule

## Problem

Every `fs.opendir()` call site must guarantee the returned `Dir` handle is closed, including on
throw and early return. Today this contract is enforced by hand at each site, and some sites do not
enforce it at all. The result is file-descriptor leaks that only surface under load, plus
near-verbatim duplication of the try/finally close pattern across a dozen files.

## Evidence

There are 11 production `opendir` call sites (excluding tests and bench fixtures).

Five already close in a `finally` block:

- `src/shared/grok-session-paths.ts:196-202`
- `src/main/window/clipboard-remote-file-staging.ts:217-218`
- `src/main/skills/skill-package-identity.ts:227-228`
- `src/main/skills/skill-upload-staging-ownership.ts:61-62`
- `src/main/skills/skill-plugin-cache-scan.ts:227-228`

Six rely on implicit close, which only happens when the async iterator runs to completion:

- `src/shared/quick-open-directory-reader.ts:31-32` is the worst case: it can throw
  (`throwIfFileListingCancelled`, `assertQuickOpenReaddirDeadline`) *between* `opendir` and the
  `for await` loop. That throw leaks the handle with no chance for implicit close. This is a real
  leak, not a theoretical one.
- `src/shared/linux-proc-socket-owner-scanner.ts:11` is an async generator over a `Dir`. If the
  consumer `break`s or throws, the generator is suspended and never resumes, so the handle is
  only reclaimed by GC. This produces relay logs of the form "Closing directory handle on garbage
  collection" and was reported upstream in issue #12895.

Duplication: `src/relay/workspace-space-scan.ts:152-171` and
`src/main/workspace-space-local-scan.ts:60-116` carry near-identical scan plumbing (opener,
cancellation, du-size collection) that a shared helper would collapse.

Additionally, `src/shared/grok-session-paths.ts:128-130` privately reinvents a Dirent-like
interface (`GrokSessionDirectory = AsyncIterable<GrokSessionDirectoryEntry> & { close }`) purely
to make the handle mockable/closeable. A shared helper removes the reason for that local type.

Precedent for enforcement exists: `config/oxlint-plugins/` already hosts 4 custom plugins
(`mobile-pairing-qrcode-import.mjs`, `quadratic-buffer-concat.mjs`, `app-store-performance.mjs`,
`renderer-scrollbar-style.mjs`), and `config/scripts/check-runtime-electron-ratchet.mjs` shows the
ratchet script template this repo already uses for shrink-only counts.

## Design

New module `src/shared/fs-opendir-scope.ts` exporting:

```ts
export async function withDir<T>(
  path: string,
  fn: (dir: Dir) => Promise<T>,
  opts?: { signal?: AbortSignal }
): Promise<T>
```

`withDir` opens the directory, runs `fn`, and always closes the handle in a `finally` (close
errors swallowed and logged, matching the existing `close().catch(() => undefined)` convention).

```ts
export async function listDirSafe(
  path: string,
  consume: (name: string) => Promise<void> | void,
  opts: { signal?: AbortSignal; budget?: ReadBudget }
): Promise<void>
```

`listDirSafe` wraps `withDir`, iterates entries, and honors cancellation plus an entry/path budget
at every step, so the quick-open deadline/budget logic in
`src/shared/quick-open-directory-reader.ts` ports over unchanged.

Migrate all 11 sites in the same PR. The five try/finally sites are mechanical rewrites; the
quick-open site fixes its leak by construction; the proc-socket scanner becomes a `withDir` loop
that pushes into a bounded buffer instead of an unbounded async generator.

Enforcement: new oxlint plugin (e.g. `no-raw-opendir.mjs`) in `config/oxlint-plugins/` that flags
`fs.opendir` / `opendir(...)` imports and calls outside an allowlist containing exactly
`src/shared/fs-opendir-scope.ts`.

## Explicit resource management

The repo now supports `using` / `await using` (TS 7, Electron 43; verified by compiling a probe).
Internally, `withDir` / `listDirSafe` use `await using` over an AsyncDisposable wrapper for the
handle teardown. The public callback API is unchanged, so every migrated call site remains a
one-liner. For generator-shaped sites where the handle must survive across suspension, export a
`DirScope`-style class implementing `Symbol.asyncDispose` so the site can hold it in a `try`
block or hand it to an explicit scope.

## YAGNI

- No generic `ResourceScope` / `ResourceT` monad abstraction. Two functions plus a
  `DirScope`-style class cover the actual call sites.
- No TaskGroup or structured-concurrency framework. Fail-fast orchestration stays native
  AbortController + `Promise.all`. Budget/cancellation dedup reuses existing AbortSignal
  conventions (see `quick-open-readdir-budget.ts`). No new dependencies such as p-limit or
  p-map; the repo does not depend on them today.
- No new `readdir` API beyond what exists; we do not unify the relay and main workspace scans'
  injection interfaces, only their directory-iteration core.
- No backpressure, pooling, or fd-count telemetry.

## Measurement

Grep-able metric: `grep -rn "opendir(" src --include='*.ts' | grep -v test` call sites with a
guaranteed close goes from 5/11 to 11/11. The count is gated in CI by the lint rule: any new raw
`opendir` call site fails lint unless the allowlist is edited, and allowlist edits are reviewable.

## Effort

S. One shared module (~120 lines), 11 mechanical migrations, one small oxlint plugin.

## Tests

- Module-local tests next to the migrated files (quick-open budget/cancel still pass,
  proc-socket scanner handles consumer abort).
- New tests for `fs-opendir-scope.ts` covering close-on-throw and close-on-cancel.
- Snapshot test for the oxlint rule (valid allowlist site, violating site, allowlist edit path).

## PR split

1. `src/shared/fs-opendir-scope.ts` + migration of all 11 call sites + module tests.
2. Oxlint rule + allowlist + rule snapshot test.

Splitting keeps the diff reviewable while PR 2 cannot be merged before the codebase is already
compliant.
