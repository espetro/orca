# Scripts TypeScript migration

`config/scripts/` was migrated from `.mjs`/`.cjs` to `.ts`/`.cts`. The
end state: every script in `config/scripts/` is a typed `.ts` (ESM) or `.cts`
(CJS) file, typechecked against `config/tsconfig.scripts.json`.

## What this unlocks

- Type errors surface at compile time instead of in CI logs. The four latent
  oxlint type-aware rules (`await-thenable`, `no-redundant-type-constituents`,
  `restrict-plus-operands`, `restrict-template-expressions`,
  `switch-exhaustiveness-check`) now apply to scripts. A new
  `typescript/no-floating-promises` rule is scoped to `**/*.ts` / `**/*.cts`
  via the type-aware oxlint override.
- Cross-extension imports from `config/scripts/*.mjs → src/**/*.ts` (24 sites
  today) become type-checked end-to-end. Symbols flow from `src/shared` into
  scripts for free.
- The `bin.orca-dev` entry points directly at `./config/scripts/orca-dev.ts`
  — the repo pins Node 24.

## Developer workflow

- `pnpm tc` — runs `tc:node`, `tc:cli`, `tc:web`, and `tc:scripts` in
  parallel. Use this as your typecheck gate.
- `pnpm tc:scripts` — typecheck only `config/scripts/**/*` against
  `config/tsconfig.scripts.json`. Useful when working on a script in
  isolation.
- `pnpm lint` — runs oxlint + the audit chain. Scripts get the same lint
  coverage as the rest of the tree via the `**/*.ts` / `**/*.cts` overrides
  in `.oxlintrc.json`.

## Migration rules of thumb

- Renames are atomic: rename the file and update every importer's specifier
  in the same commit. No broken intermediate states on `main`.
- Prefer `unknown` + narrowing over `any`. Use `as const` liberally on
  data tables.
- Import attributes (`import x from './y.json' with { type: 'json' }`) replace
  `JSON.parse(readFileSync(...))` calls — one-line typed imports, no runtime
  overhead.
- `using` / `await using` (TC39 stage 3, Node 24 supports it) replaces
  `try/finally` boilerplate for disposable handles (timers, child processes,
  file watchers).
- No `// @ts-ignore` or `// @ts-nocheck`. If you can't make tsc happy, use
  `eslint-disable-next-line typescript/no-explicit-any -- Why:` with a
  one-line justification per project policy.
