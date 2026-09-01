# Intl-AI Locale Translation Discovery

**Date**: 2026-09-01
**Branch**: `migrate/scripts-to-ts` (worktree `.worktrees/scripts-to-ts`)
**Author**: Joaquin Terrasa
**Status**: Discovery only — no code changes proposed in this report

---

## TL;DR

No `intl-ai` / OpenRouter / locale-translation automation code exists in the repo today. The previous scripts-to-TS migration ROI report (`migration-roi-2026-09-01.md:124`) explicitly noted the intl-ai reference was an outdated plan item, not built. Translation policy is well-defined (gettext PO, delta-driven, risk-based review) but the automation step is deferred until PR A/B/C/D ship. There is a clear, narrow opening for an OpenRouter-backed locale translation pipeline that fits between **PR D** (PO becomes canonical) and the deferred **"translation automation"** section of `config/i18n-translation-source.md:387-391`.

**Recommendation before any code**: confirm scope with the user — should intl-ai (a) drive the deferred PR-E automation, (b) bootstrap/refresh non-English locales now while the JSON catalog is still canonical, or (c) target a narrow surface (e.g. mobile bridge, plugin language packs) only. Each has different file/script shapes.

---

## 1. Existing state

### 1.1 Code references: zero

`grep -r "intl-ai|intl_ai|translateLocale|translate-locale|openrouter|OpenRouter"` across the worktree (excluding `node_modules` / `.git`) yields:

| Path                                              | What it is                                                                                                                                                                                            |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.agents/reports/migration-roi-2026-09-01.md:124` | The only hit. Marks "intl-ai" as an outdated plan reference. No code, no docs.                                                                                                                        |
| `.github/workflows/pullfrog.yml:42`               | `OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}` — used by Pullfrog (third-party AI agent for PR review). **Not a translation script.** Pre-existing secret already provisioned in GH Actions. |

No script in `config/scripts/` imports `@openrouter/*`, makes HTTP calls to `openrouter.ai`, or deals with machine translation providers. No `intl-ai*` files anywhere.

### 1.2 Design references: documented, deferred

`config/i18n-translation-source.md` (24 KB, the canonical architecture doc) describes translation automation as a **deferred follow-up**, not a built feature:

- `i18n-translation-source.md:387-391` — "The first automation follow-up should create or update localization-only changes containing only missing and stale entries. It should not rewrite a whole locale."
- `i18n-translation-source.md:263-296` — full "Translation automation" section. Seven-step model: reconcile → batch → prompt with context → preserve unaffected → mark provenance → validate → fallback.
- `i18n-translation-source.md:280-285` — risk-based human review is required for destructive/auth/billing/privacy/legal/OS-prompt copy. "Routine labels and descriptions may use validated machine translation under the adopted release policy. A model-provided confidence score alone is not sufficient release evidence."
- `i18n-translation-source.md:393-509` — alternatives considered (XLIFF 2.0, 1.2, JSON, bespoke bilingual, proprietary translation platform). The doc explicitly does **not** pick a provider; it stipulates that a translation provider "should not become Orca's sole source of truth or a runtime dependency" and that "selecting one before the repository contract exists would create premature vendor coupling."
- `i18n-translation-source.md:530-540` (in the deferred phase) — "Post-merge localization automation owns all PO mutations" — the architecture positions automation as something that mutates PO files, not the JSON catalogs in `src/renderer/src/i18n/locales/`.

### 1.3 Translation policy infrastructure: mature, JSON-shaped

Today the policy lives in `config/scripts/` as roughly 35 `.mts`/`.mjs` files that operate on the JSON catalogs (not PO files yet):

- `locale-translation-policy.mts` — coordinator. Imports brand/glossary/key-override/phrase-fix/style modules.
- `locale-brand-mistranslations.mts` — `NEVER_TRANSLATE_VALUES` set with ~80 brand names (Codex, Claude, Orca, …) and `BRAND_MISTRANSLATIONS` per locale.
- `locale-generic-ui-terms.mts` — canonical rendering detector (catches copied-English strings).
- `locale-key-overrides.mts` + `locale-value-overrides.mts` — per-key / per-value corrections.
- `locale-phrase-fixes.mts` — locale-specific phrasing corrections.
- `locale-cjk-latin-spaced-terms.mts`, `locale-screen-cursor-exemptions.mts`, `locale-style-values.mts` — narrow exemptions.
- `locale-{ja,ko,zh}-*.m(ts|json)` — language-specific overrides (ja has the largest set, ~80 KB; ko overrides alone are ~192 KB).
- `locale-translation-policy.{es,ja,ko,zh}-*.test.mjs` — risk-prioritized policy test rounds.

These are the **glossary and never-translate list** that the policy doc says should live in stable QA inputs (`i18n-translation-source.md:292-296`). They're the inputs an LLM translator would need in its prompt.

### 1.4 PR A is merged; PR B-D not landed

- **PR A** (`#8512`, merged) — sparse target catalogs, English fallback authoritative, no more whole-catalog sync. References: `i18n-translation-source.md:300-319`.
- **PR B-D** — not implemented yet. PO source + read-only compiler + one-time migration + PO-becomes-canonical. Until PR B lands, **PO files don't exist in the repo**; the JSON catalogs in `src/renderer/src/i18n/locales/` are still the canonical target translation source.

This is the load-bearing constraint: any intl-ai script written today must target JSON catalogs, and will likely be rewritten (or substantially reworked) when PR B ships.

---

## 2. Locale surface

### 2.1 File inventory

```
src/renderer/src/i18n/locales/
├── en.json   17,110 lines,  847 KB   13,676 leaves  (source of truth — 15 top-level sections)
├── es.json   14,835 lines,  802 KB   11,963 leaves  (12 top-level; 1,713 behind en)
├── ja.json   14,835 lines,  923 KB   11,963 leaves  (12 top-level; 1,713 behind en)
├── ko.json   14,939 lines,  839 KB   12,056 leaves  (12 top-level; 1,620 behind en)
└── zh.json   14,939 lines,  733 KB   12,060 leaves  (12 top-level; 1,616 behind en)
```

Total: ~4.1 MB, ~76,658 lines, 60,718 leaf strings across 4 target locales plus 13,676 in English.

### 2.2 Source of truth: `en.json`

`en.json` is canonical. It has 15 top-level sections (`app`, `browser`, …) while every other locale has 12 — the missing 3 are intentional English-only sections (likely agent labels, OS prompts, technical literals that policy says must stay English). Translator work targets any leaf where `target[locale][key]` is missing OR present-but-stale relative to `en[key]`.

### 2.3 Outstanding translation work

Non-trivial observations:

- **zh** is closest to en (1,616 missing leaves) but has line density **lower** than en because zh strings are denser characters-per-line. **es/ja/ko** each trail by ~1,620–1,720 leaves.
- The locale-specific override files (`locale-ja-value-overrides.mts` is 39 KB, `locale-ko-value-overrides.mts` is 15 KB) suggest heavy post-MT correction has already happened for ja/ko. **zh** has fewer overrides.
- Per `i18n-translation-source.md:317-319`: 2,055 English keys are unreferenced at decision time, and the deletion ratchet grows them until PR C. So real translator work at any given moment is closer to ~1,600–1,700 leaves per non-English locale, not 13,676.
- **Placeholders**: `i18n-translation-source.md:186-210` flags 825 of 954 interpolated strings use positional placeholders (`{{value0}}`). A translator must not lose them. Output must pass placeholder-validation as part of QA.

### 2.4 Other surfaces that would touch intl-ai (out of immediate scope, but worth knowing)

Per `i18n-translation-source.md:242-261`:

- **Mobile**: separate catalog tree with its own key scheme. Same PO contract, separate PO files, additional projections (iOS `InfoPlist.strings`, Android resources).
- **Plugin language packs**: external overrides validated against compiled core keys. Consumer of the contract, not a canonical source.

These mean intl-ai should not assume a single `src/renderer/src/i18n/locales/en.json` is the only source — but for V1 this is the only surface with JSON files checked in.

---

## 3. Proposed scripts

All under `config/scripts/`, named to match the existing `locale-*` and `localize-renderer-strings.mts` conventions. Filenames follow the policy in `AGENTS.md` ("File and Module Naming" — name after the domain concept, not "helpers").

### 3.1 Primary deliverables

| Path                                                | Purpose                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config/scripts/intl-ai-translate-locales.mts`      | Main entrypoint. Loads en.json + missing/stale leaves per target locale, batches, calls OpenRouter, writes back to JSON. Supports `--target <locale>`, `--dry-run`, `--batch-size <n>`, `--concurrency <n>`, `--model <id>`.                                                                 |
| `config/scripts/intl-ai-prompt-builder.mts`         | Composes prompts per batch. Injects: brand never-translate list (`NEVER_TRANSLATE_VALUES`), `BRAND_MISTRANSLATIONS`, generic-UI-term exclusions, per-locale overrides, placeholder rules, previous `#\| msgid` analogue (from git diff or stored). Returns structured `{system, user}` JSON. |
| `config/scripts/intl-ai-response-parser.mts`        | Validates model output: extracts JSON map, checks placeholder parity (`{{name}}` set equality), length sanity, brand-list compliance, identical-to-English flag for non-`NEVER_TRANSLATE` exemption.                                                                                         |
| `config/scripts/intl-ai-rate-limiter.mts`           | Token-bucket + 429-aware retry. Reads OpenRouter rate-limit headers (`x-ratelimit-*`) when present. No-op when running under `INTL_AI_DISABLED=1`.                                                                                                                                           |
| `config/scripts/intl-ai-translate-locales.test.mts` | Vitest. Fixtures: 50-entry batch with placeholders, brand names, identical-to-English suspect, multiline. Asserts: round-trip placeholder parity, brand-name preservation, identical-to-English ratchet decrement.                                                                           |

### 3.2 Optional / follow-on

- `config/scripts/intl-ai-bootstrap-locale.mts` — initial fill of a locale from a fresh en.json (e.g. mobile bridge). Separate from delta-update because it uses larger batches and a different provenance policy.
- `config/scripts/intl-ai-report.ts` — produces a per-run markdown report (which keys filled, which were demoted to fuzzy, identical-to-English candidates, unmatched placeholders). CI-friendly.

### 3.3 Reuse points (do not duplicate)

These already exist and intl-ai should **import from**, not reimplement:

- `locale-translation-policy.mts` — re-export brand terms and never-translate list. (`NEVER_TRANSLATE_VALUES`, `BRAND_MISTRANSLATIONS`)
- `locale-generic-ui-terms.mts` — `isCanonicalGenericRendering()`, `overlapsCanonicalRendering()` — detects suspected copied-English output.
- `locale-brand-mistranslations.mts` — per-locale brand correction catalog (used as an "avoid these translations" prompt).
- `locale-key-overrides.mts` + `locale-value-overrides.mts` — `LOCALE_KEY_OVERRIDES`, `LOCALE_VALUE_OVERRIDES` — already reviewed corrections; feed into prompt as "do not regress."
- `audit-localization-coverage.mjs` — `collectLocalizationCandidates()` — used by `localize-renderer-strings.mts`; can drive stale-leaf detection.
- `verify-localization-catalog.mts` — existing catalog validator. intl-ai output should pass this before commit.

### 3.4 What would NOT be in scope for V1

- PO file writer (defer until PR B lands).
- Mobile native-resource projection (defer until mobile PO files exist).
- Confidence-score reporting as a release signal (explicitly disallowed by `i18n-translation-source.md:284-285`).
- Plugin language-pack automation (defer per the same doc, `i18n-translation-source.md:258-261`).

---

## 4. API key handling

### 4.1 Stash path

`/Users/josocjoq/Documents/prjcts/_own/stash/.env` (315 B, confirmed to exist) contains:

```
OPENROUTER_API_KEY="sk-or-v1-REDACTED-KEY-ROTATED"
OPENROUTER_MODEL_ID="openrouter/free"
```

### 4.2 Loading strategy

Recommendation: **`dotenv` against the absolute stash path, fail loud if missing, never commit.**

```ts
// pseudocode, not code yet
import { config } from 'dotenv'
import path from 'node:path'
import process from 'node:process'

const STASH_ENV = '/Users/josocjoq/Documents/prjcts/_own/stash/.env'
if (!process.env.OPENROUTER_API_KEY) {
  config({ path: STASH_ENV }) // dotenv@17.4.2 already a transitive dep
}
if (!process.env.OPENROUTER_API_KEY) {
  throw new Error(
    'OPENROUTER_API_KEY not set. Source /Users/josocjoq/Documents/prjcts/_own/stash/.env or set in shell.'
  )
}
```

Why this shape:

- `dotenv@17.4.2` is already a transitive dependency (`pnpm-lock.yaml: ... 'dotenv@17.4.2'`). No new dependency required.
- The script never logs, prints, or echoes `process.env.OPENROUTER_API_KEY`. Existing scripts in `config/scripts/` follow the same `process.env.X` pattern (see `hang-watchdog-memory-benchmark.mts`, `resolve-7za-path.mts`).
- `INTL_AI_DISABLED=1` short-circuits all network calls and exits 0 — matches the offline-fallback contract from `i18n-translation-source.md:84` ("Orca must not require network access or a translation service to display localized UI").
- The `--dry-run` flag must work with `OPENROUTER_API_KEY` unset (validates batch plan + prompt shape, no network).

### 4.3 Never commit

- `stash/.env` is outside the repo. The key never enters the worktree.
- Add an `.env` line in `.gitignore` (`/Users/josocjoq/.gitignore` is `4.1K`; check existing ignore set before adding).
- CI uses the pre-existing `OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}` secret (`pullfrog.yml:42`). The same secret name works for any new GH workflow we add.
- If asked to add a smoke-test workflow, route through `secrets.OPENROUTER_API_KEY` — never inline.

### 4.4 Paid-key safety

`OPENROUTER_MODEL_ID="openrouter/free"` routes to OpenRouter's free-model router. To prevent accidental paid spend:

1. The script must read the **model id from env**, not argv, for the model only when the env says `openrouter/free` or an explicit allowlist. Any other model id, refuse to run unless `--allow-paid` is passed.
2. Before each API call, log (to stderr) the model id and the resolved estimated cost. If `model` is not in `OPENROUTER_FREE_MODEL_ALLOWLIST` and `--allow-paid` is not set, refuse.
3. Add a per-run `MAX_TOKENS` budget hard-cap (e.g. default 1M input tokens, configurable) and bail with non-zero when exceeded.
4. Recommend (out of band): keep a separate paid OpenRouter account, key stored under a different env name (`OPENROUTER_PAID_API_KEY`), and never accept both env vars in the same process.

---

## 5. Rate-limit strategy

### 5.1 OpenRouter free tier — known constraints

OpenRouter does not publish a single tight number for free-model RPS because the limit is **per free-model provider**, not per OpenRouter account. Empirically (and from public docs):

- Free models typically allow **~20 requests/minute** with daily token caps (varies per model).
- Free models regularly hit capacity; expect `429` and `503` with the message "free model is currently unavailable" or "provider capacity exceeded."
- Rate-limit headers (`x-ratelimit-*-remaining`, `retry-after`) are emitted when the upstream provider forwards them. **Some free models do not.**

### 5.2 Batching + retry strategy

Rather than try to game rate limits precisely, design for forgiveness:

1. **Batch size**: default 20–40 entries per request. Small enough to keep prompts under ~6 KB. Large enough that 1,700 missing leaves per locale = ~50 calls.
2. **Concurrency**: `--concurrency` default 2 (parallel). Hard ceiling 4. Allow `--sequential` for CI.
3. **Retry**: `intl-ai-rate-limiter.mts` handles 429 with exponential backoff `1s, 2s, 4s, 8s, 16s, 32s` then gives up after 6 attempts (~63s per failed batch). 503 retried similarly but only 3 attempts.
4. **Persistent state**: write a per-run `.jsonl` checkpoint after each successful batch. On resume, skip already-translated keys. Makes long runs restartable.
5. **Cooldown loop**: when a response header says `retry-after: N`, sleep N seconds, then continue. When no header but 429, fall back to backoff.
6. **Skip-and-continue**: if a batch fails 6 times, log the key ids, leave them untouched, do not abort the run. Surface them in the post-run report.
7. **Per-locale serial**: do not call the API in parallel across _different_ locales. One locale at a time, so a run reads `en.json` once and outputs `zh.json`, `ja.json`, etc. sequentially. This avoids one locale's 429s starving another.

### 5.3 Rough full-run budget

13,676 leaves × 4 locales ≈ 54,700 placeholders to fill. Real gap ~6,500 leaves (1,700 × ~4 locales, but actually deduped since many leaves overlap). Let's say **~7,000 leaves to translate**.

- At 30 entries/batch × 5 batches/min (free-tier conservative ceiling) = ~150 entries/min.
- 7,000 / 150 ≈ **~47 minutes wall-clock** for all four locales.
- Single locale (1,700 leaves) ≈ **~12 minutes**.
- Single locale with full offline fallback = **0 network**, exits immediately. Use `--dry-run` first.

---

## 6. ROI estimate

### 6.1 Current cost (manual)

Each non-English locale currently lags ~1,650 leaves behind en. Empirical: a skilled human translator on vetted UI copy averages ~150–250 short strings/hour including context switches. Reviews in `config/scripts/locale-{ja,ko,zh}-*.m(ts|json)` show heavy post-MT correction, suggesting prior runs were MT-then-human.

- Manual (cold): **~8 h / locale** at 200 strings/h = 32 h for 4 locales.
- Manual (review-only on MT output): ~2 h / locale = 8 h.
- Adding a single English feature (e.g. ~30 new strings) and propagating: **~1 h per locale** for the per-feature maintainer today.

### 6.2 With intl-ai (assumption: model quality ≈ MT baseline)

- Cold-fill a locale: ~12 min compute + ~2 h human review of MT output (still required per `i18n-translation-source.md:280-285` for risk-flagged copy). Net: 2 h vs 8 h → **~75% reduction**.
- Per-feature delta (30 strings): ~30 s compute + ~10 min review. Net: 10 min vs 1 h → **~83% reduction**.
- Annual cycles: assuming ~4 cycles/year of large drop, ~30 small feature-string delta PRs, and a 50% compute-vs-review mix:

| Workload                            | Manual    | intl-ai                | Δ                 |
| ----------------------------------- | --------- | ---------------------- | ----------------- |
| 4 large drops × 4 locales × 8 h     | 128 h     | 4 × 4 × 2 h = 32 h     | **−96 h**         |
| 30 small deltas × 4 locales × 0.5 h | 60 h      | 30 × 4 × 0.17 h ≈ 20 h | **−40 h**         |
| **Total / year**                    | **188 h** | **52 h**               | **−136 h** (~72%) |

### 6.3 Cost (free model)

- OpenRouter `openrouter/free` is **$0**. Free-tier RPS is the only limit.
- Worst-case escalation to a paid model (`google/gemini-2.5-flash` ≈ $0.30 / 1M input tokens, ~$1.20 / 1M output): 7,000 leaves × ~50 input tokens + ~50 output tokens ≈ 700k tokens total → **<$1 per full-run**. Even a paid model is trivial.
- Real cost: **human review time**, not tokens. Everything in §6.2 already prices review in.

### 6.4 Caveat

Returns collapse if the model quality is poor enough that the human review cost equals the manual cost — i.e. if MT output requires a full rewrite rather than a polish. Mitigations:

- **Dry-run** mode that shows prompts and exits without calling the API — lets reviewers eyeball one batch before committing.
- **Identical-to-English ratchet**: skip output strings that came back unchanged (or near-unchanged) — this is the v2 of `audit-localization-coverage.mjs` and prevents free-model laziness from accumulating.
- Existing per-locale override infrastructure (`locale-{ja,ko,zh}-value-overrides.mts` etc.) is the _audit_: if intl-ai grows them aggressively, the model is regressing.

---

## 7. Risks

| Risk                                                                     | Severity                                                      | Mitigation                                                                                                                                                                                                                |
| ------------------------------------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Free-model quality drops below MT baseline**                           | High                                                          | Build a `--dry-run` so reviewers can validate prompts before any spend. Add identical-to-English ratchet. Compare intl-ai output to current locale files via `verify-localization-catalog.mts`; ratchet must not regress. |
| **Hallucinated keys / drift** (model invents new keys not present in en) | Medium                                                        | The parser only accepts keys present in the input batch. Any extra/missing keys fail the batch and demote to retry. Strict allowlist of keys per batch.                                                                   |
| **Placeholder loss** (`{{value0}}` dropped, renamed)                     | High                                                          | Parse with `intl-locale.test.ts`-style placeholder extraction; reject any output whose placeholder set differs from input. Hard fail, never fuzzy.                                                                        |
| **Brand-name mangling** (Codex → 写代码, Claude → 克劳德)                | High                                                          | `NEVER_TRANSLATE_VALUES` enforced by `locale-translation-policy.mts`; post-translation pass runs `BRAND_MISTRANSLATIONS` regex set against output and demotes hits.                                                       |
| **Locale consistency drift** between intl-ai and manual rounds           | Medium                                                        | Every batch output recorded in a `.intl-ai/` log; a vitest test asserts `locale-translation-policy.{ja,ko,zh}-*.test.mjs` still passes (those are ratchet-style).                                                         |
| **Cost overrun from paid model**                                         | Low (if env is read-only) → High (if model is `--allow-paid`) | Refuse any model not in `OPENROUTER_FREE_MODEL_ALLOWLIST` unless `--allow-paid` is set; `--allow-paid` requires confirmation prompt unless `INTL_AI_ALLOW_PAID=1`. Max token budget per run.                              |
| **Key accidentally committed**                                           | High                                                          | `.env` already gitignored. CI uses `secrets.OPENROUTER_API_KEY` only. Add a vitest guard: `grep -R OPENROUTER_API_KEY config/scripts/*.mts` must match 0 lines (only `process.env.OPENROUTER_API_KEY` allowed).           |
| **PR B lands and intl-ai targets obsolete JSON**                         | Medium (deferred)                                             | Footnote in script: `// TODO(migration): re-target to PO once PR B lands. Until then, output is JSON. Consumers: verify-localization-catalog.mts.`                                                                        |
| **OpenRouter service down for hours**                                    | Low                                                           | `--offline` flag falls back to current English copy (which is what `i18n-translation-source.md` says must happen anyway); script never blocks CI.                                                                         |
| **OpenRouter response-shape drift** (schema changes)                     | Low                                                           | Schema-validate every response with `zod`-equivalent (or hand-rolled type guard); log raw response on parse failure for postmortem.                                                                                       |

### 7.1 Risk-not-a-risk

- **No PR-B coupling**: the script targets JSON today. PR B will require rewrite anyway. Don't try to predict the PO shape.
- **No mobile/PWA in V1**: out of scope per `i18n-translation-source.md:244-257`.
- **No conflict with manual translators**: the script emits JSON catalog updates that pass the existing `verify-localization-catalog.mts` policy. Manual reviewers continue to use the existing override files (`locale-{lang}-value-overrides.mts`) — they can edit intl-ai output inline.

---

## 8. Open questions for the user

Before writing any code, pick:

1. **Scope**: V1 fills JSON missing leaves only? Or also stale leaves (en changed since last translation)?
2. **Locales**: all four (es, ja, ko, zh)? Or one first (recommend **zh** — closest to en, smallest override file, simplest review surface) for a pilot?
3. **Trigger**: one-shot CLI for a human operator only? Or also a GH Action on en.json change?
4. **PO awareness**: do nothing about PR B today? Or write to JSON with a stable intermediate format that PR B can ingest?
5. **Free model choice**: pin `openrouter/free` for the allowlist? Or pin to specific free models (`meta-llama/llama-3.3-70b-instruct:free`, `qwen/qwen-2.5-72b-instruct:free`, etc.) for determinism?
6. **Identical-to-English ratchet behavior**: drop identical outputs silently, or always write them and mark pending-review?
7. **Stash dotenv vs shell env**: which is the default for the user's daily workflow? Recommend stash-only with manual override.

---

## 9. Recommendation

**Do not start coding yet.** The interaction surface with PR B, the policy doc, the override files, and the brand/glossary modules is too rich to commit code without the scope questions in §8 answered. Next step is to align with the user on §8 items, then build a **pilot for one locale (recommend zh) with `--dry-run` first and manual review of one batch output** before touching any JSON catalog file.

If the user wants to proceed without further alignment, the minimum viable plan is:

1. `config/scripts/intl-ai-translate-locales.mts` (entrypoint + batching + dry-run)
2. `config/scripts/intl-ai-prompt-builder.mts` (imports `locale-translation-policy.mts` exports)
3. `config/scripts/intl-ai-translate-locales.test.mts` (placeholder parity + brand-name preservation on a 50-entry fixture)
4. `.env.example` (or a doc line in `docs/`) explaining how to source the key from the stash path

Estimated deliverable: ~3 files, ~600 LoC, 2 days to pilot-ready with a single locale.
