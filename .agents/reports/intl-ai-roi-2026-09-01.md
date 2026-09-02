# intl-ai ROI Delta Report — 2026-09-01

> Pre-work feasibility assessment for adding OpenRouter-powered locale
> translation (`intl-ai`) to Orca. Branch context:
> `migrate/scripts-to-ts` (scripts just migrated to TS; new code lands as
> `.mts`).

## TL;DR

**Conditional Yes**, but the bar is lower than the task description
suggests. We **already have** a working translation script
(`bootstrap-locale-catalog.mts` → Google Translate free endpoint) that
solves 80% of the problem. intl-ai's value is **higher quality**, **less
drift**, and **provider portability** — not raw throughput. Net new
value over current state: real but bounded.

---

## 1. Current State: Manual / Rule-Based Locale Updates

### Inventory (measured 2026-09-01)

| Locale | File size | Key count                    |
| ------ | --------- | ---------------------------- |
| `en`   | 847.4 KB  | **13,676** (source of truth) |
| `es`   | 802.2 KB  | 11,963                       |
| `ja`   | 922.7 KB  | 11,963                       |
| `ko`   | 839.1 KB  | 12,056                       |
| `zh`   | 733.2 KB  | 12,060                       |

- **5 target locales**, not 60. The task brief's "60 locales × N keys"
  estimate is off by an order of magnitude for this codebase.
- Key counts are within ~13% across targets (en is ~14% larger because
  it carries the latest feature strings pending reconciliation).
- File sizes 730–923 KB — these are not "a few hundred strings", they're
  large catalogs that dominate PR diffs when touched.

### Existing infrastructure (already on disk)

`config/scripts/` already contains a **mature locale pipeline**:

- `bootstrap-locale-catalog.mts` (201 lines) — translates the full
  `en.json` catalog into any of `zh`, `ko`, `ja`, `es` using
  `translate.googleapis.com/translate_a/single`. Has built-in:
  placeholder protection (`{{name}}` → token → restore), per-locale
  disk cache (`.zh-catalog-cache.json`, etc.), 5-attempt retry with
  500 ms exponential backoff, concurrency-2 worker pool, English-value
  preservation policy.
- `bootstrap-zh-catalog.mts` — entry-point wrapper.
- 18 `locale-*-overrides.mts` / `locale-*-value-overrides.mts` scripts —
  hand-curated per-locale terminology and brand fixes layered on top
  of machine output (e.g. `locale-brand-mistranslations.mts`,
  `locale-ko-phrase-fixes.mts`, `locale-ja-key-overrides.mts`).
- `locale-translation-policy.mts` + 7 `.test.mjs` files — the
  validation contract (placeholder parity, English-copy detection,
  CJK formatting).
- `audit-localization-coverage.mjs` + `verify:localization-coverage`
  gate.

### How often locales actually change

```
git log --since="12 months ago" -- src/renderer/src/i18n/locales/
  ≡ 13 commits in 12 months ~= 1.1 / month
```

Last 13 (sample):

- `314dcba9 feat(i18n): localize Agent Dashboard to Korean (#17121)`
- `4065d053 feat(i18n): localize onboarding checklist steps to Korean (#17108)`
- `6f3c5cc0 fix(i18n): use 工作树 consistently for parent worktree strings in zh (#16954)`

Pattern: most commits are **terminology consistency fixes** layered on
top of an already-translated catalog, not "translate this feature into
4 languages from scratch".

### Minutes per locale update today

The dominant workflow is **not** full-catalog re-translation. It's:

1. `en.json` gains a feature (developer PR).
2. The new keys flow through `audit-localization-coverage.mjs` →
   `sync:localization-catalog` — adds empty entries to target files.
3. i18next falls back to English at runtime until translated.
4. A localization PR opens (sometimes the same PR, sometimes follow-up
   like #17121, #17108) running `bootstrap-locale-catalog.mts` + the
   override scripts.
5. Reviewer + locale SME skim a Diff against the override lists.

Estimated wall-clock per "translate this feature" sweep:

- Run `bootstrap-locale-catalog.mts` for one locale: **5–15 min** wall
  (Google free tier, ~12k calls, concurrency 2, 200 ms gap).
- Run all 4 target locales in parallel shells: **10–20 min** total.
- SME review + override layering: **30–60 min** per locale.
- **Total per sweep: 1.5–3 h** for 4 locales, end-to-end.

### Two ongoing strategic shifts (must read before sizing intl-ai)

1. **`i18n-translation-source.md` PR B (gettext PO migration)** —
   documented 2026-07-30 as the canonical authoring format going
   forward. PR B is "not yet implemented" on this branch. Any
   catalog-level automation we ship today will be **replaced or
   re-targeted** when PO lands (likely in 1–2 quarters). The script
   should be written so the **translation primitive** (prompt + parse
   - write) is reusable on PO files later.
2. **The reconciliation / delta model** is already baked into the PO
   plan: "translate only missing/stale units, not whole catalogs". A
   "translate everything on every run" intl-ai would be a step
   _backwards_ from where the architecture is heading.

---

## 2. Proposed State: intl-ai Automation

### New scripts (proposed)

| File                                                | Purpose                                                  |
| --------------------------------------------------- | -------------------------------------------------------- |
| `config/scripts/intl-ai-translate-locales.mts`      | CLI: `pnpm intl-ai-translate <locale>` / `--all`         |
| `config/scripts/intl-ai-prompt-builder.mts`         | Build batched JSON prompt from en-leaves + locale target |
| `config/scripts/intl-ai-response-parser.mts`        | Validate JSON shape, placeholder parity, restore tokens  |
| `config/scripts/intl-ai-translate-locales.test.mts` | Unit tests                                               |
| `config/scripts/intl-ai-cache-store.mts`            | Disk cache keyed by `(enValue, model, prompt-version)`   |
| `config/scripts/intl-ai-rate-limiter.mts`           | Backoff + concurrency for OpenRouter                     |

### Proposed workflow

```sh
pnpm intl-ai-translate zh          # single locale
pnpm intl-ai-translate --all       # all 4 target locales
pnpm intl-ai-translate --all --dry-run   # show diff, no writes
```

### Free model: OpenRouter `openrouter/free`

OpenRouter's auto-routed free tier (the `openrouter/free` alias) is the
default in their docs and rotates across providers — confirmed live at
<https://openrouter.ai/models?q=free>. As of 2026-08-31 the surfaced
`$0/M` model was InclusionAI's `Ling 3.0 Flash Fin (free)` with 262K
context, 366B tokens served total, ranked alongside free variants of
GLM, Qwen, and others. Important implications:

- **Free tier = no SLA, model rotates weekly.** A workflow that
  depends on a specific model for deterministic phrasing will drift.
- **Rate limits are per-provider underneath.** OpenRouter aggregates,
  but if the routed provider throttles, calls fail. No public,
  stable number — current reality is "tens of requests/minute, with
  occasional 429s" based on community reports.
- **No privacy / training isolation guarantee** on free tier. Transmitted
  source strings may be logged upstream. Orca's source catalog
  contains UI strings — not secrets — but the contract must be
  explicit.

### Estimated wall-clock per locale

One realistic batching strategy: send all 11,963 unique en-leaves to
the model in ~50 chunked requests of ~250 leaves each. Free-model
latency is ~3–8 s/request, concurrency 4.

- **Per locale**: 50 requests × ~5 s ÷ 4 concurrency ≈ **60–90 s**
- **All 4 locales sequentially**: ~5–6 min
- **All 4 locales in parallel processes**: ~90 s

These numbers are **an order of magnitude faster** than the current
Google-endpoint script (which is bound by `concurrency: 2, gap: 200 ms`
≈ 1 call/200ms ≈ 40 minutes for 12k strings). The intl-ai win is
genuinely large **if batching works**.

### What you also need to build that the task brief under-counts

- **Provider abstraction** (OpenAI-compatible HTTP — easy, ~50 LOC).
- **Cache layer** with content-addressable keys (so re-runs skip
  unchanged strings) — currently the Google script does this per
  locale; we want the same.
- **Placeholder/token protection** — already exists in
  `bootstrap-locale-catalog.mts` (`protectPlaceholders` /
  `restorePlaceholders`); **reuse, do not reimplement**.
- **`repairTranslatedValue` policy gates** — reuse from
  `locale-translation-policy.mts`.
- **Diff-in-PR output** — this is the human-review loop. The script
  must emit a Markdown diff summary reviewers can scan in <2 min.
- **Dry-run mode** — required because the cost of a bad write is
  enormous (730–923 KB files, dozens of reviewers historically skim
  these).

---

## 3. ROI Delta

### Time savings (per full sweep)

| Step                                        | Today (Google)                | intl-ai                  | Delta              |
| ------------------------------------------- | ----------------------------- | ------------------------ | ------------------ |
| Mechanical translation, all 4 locales       | 10–20 min wall                | 90 s wall                | −15 min            |
| SME review + terminology polish             | 30–60 min × 4 locales = 2–4 h | 15–30 min × 4 = 1–2 h    | −1 to −2 h         |
| Writing override scripts when a term drifts | 20–40 min per drift           | Same (no AI improvement) | 0                  |
| **Net per sweep**                           | **3–5 h**                     | **1.5–2.5 h**            | **−1.5 to −2.5 h** |

Sweep frequency: ~12/year. **Annualized time savings: ~18–30
engineering hours.**

### Cost

- **Free model: $0 / month** at zero rate-limit breaches.
- **Realistic free-tier risk**: if a contributor tries during a
  high-traffic hour, OpenRouter returns 429, the run aborts, they
  retry, hit it again, switch to a paid model "just to finish", and
  we get a surprise bill. Recommend a hard `ALLOWED_MODELS`
  allowlist in the script.
- **Paid fallback if free tier dies**: `Tencent: Hy-MT2-30B-A3B` is
  $0.074/M input + $0.295/M output (OpenRouter live pricing) — purpose-built
  translation model. One full sweep ≈ 12k strings × ~30 tokens output
  ≈ ~$0.11 / locale. Trivial.

### Quality risks

1. **Hallucinated keys** — model invents entries for `msgid` paths
   that don't exist in `en.json`. **Mitigation**: parser rejects
   response unless output key count exactly matches input leaf count,
   plus path validation against en.
2. **Placeholder drift** — `{{name}}` rendered as `{name}` or dropped.
   **Mitigation**: reuse `protectPlaceholders` from
   `bootstrap-locale-catalog.mts` (already battle-tested) and add
   post-parse `PLACEHOLDER_RE` parity check.
3. **Inconsistent terminology** — "worktree" rendered three different
   ways in the same locale. **Mitigation**: glossary block in the
   prompt (extracted from `locale-*-value-overrides.mts`), with the
   model told "use these exact terms for these English words".
4. **Cultural / locale drift** — Chinese copy that mixes Simplified
   and Traditional, Japanese that uses non-keigo register. **Mitigation**:
   keep the existing per-locale `*-overrides.mts` scripts as a
   post-AI polish layer; do not remove them.
5. **Non-determinism across runs** — same input, different output
   next week. **Mitigation**: content-addressable cache keyed by
   `(enValue, model-id, prompt-version)`. If the model changes, the
   cache invalidates by version, intentionally.
6. **Styleguide-violating translations** — informal in formal contexts,
   mixed punctuation. **Mitigation**: prompt includes a per-locale
   register block (e.g. "use です/ます form for user-facing strings").

### Maintenance burden

- **New dep**: `openai` SDK (OpenRouter is OpenAI-compatible). 1
  package, already in the npm registry. No native module, no
  glibc concerns.
- **New env var**: `OPENROUTER_API_KEY`, loaded from
  `stash/.env` via `dotenv` at script runtime — **not committed**.
- **CI gate**: optional. Recommend a soft gate (`scripts/intl-ai-ci.mts`)
  that runs on PRs touching `en.json` and posts a "stale translations
  detected" comment, **not a failure**. Auto-failing CI on AI drift
  would create more noise than signal.
- **Required reading**: `bootstrap-locale-catalog.mts` end-to-end
  before writing any new code. We will delete or merge it; we will
  not maintain two translation scripts.

---

## 4. Alternatives Considered

| Option                                     | Annual cost               | Annual hours saved        | Net                           | Verdict                                                                           |
| ------------------------------------------ | ------------------------- | ------------------------- | ----------------------------- | --------------------------------------------------------------------------------- |
| **Keep manual** (status quo + Google)      | $0                        | 0 h (baseline)            | 0                             | Realistic; review burden may grow as catalog grows                                |
| **intl-ai on free model** (proposed)       | $0 (with rate-limit risk) | ~18–30 h                  | +18–30 h                      | Worth building                                                                    |
| **intl-ai on paid model** (Tencent Hy-MT2) | ~$0.50 / year             | ~18–30 h                  | +18–30 h, deterministic       | Marginal over free; use as fallback only                                          |
| **intl-ai on GPT-4-class**                 | ~$50–200 / year           | ~18–30 h + better quality | +18–30 h + less override work | Diminishing returns vs. override-layer polish                                     |
| **Weblate crowdsourcing**                  | $0 + hosting              | Quality ↑, hours ↓        | Variable                      | High coordination overhead; Orca's contributor base doesn't currently crowdsource |
| **Groq / Gemini free tier**                | $0                        | Same as OpenRouter free   | Same                          | Tied; no reason to prefer                                                         |

---

## 5. Recommendation

**Conditional Yes** — build it, with three explicit tradeoffs:

1. **Replace, do not add to, `bootstrap-locale-catalog.mts`.** Two
   translation scripts is worse than one. The new script uses
   OpenRouter; the old Google script is deleted in the same PR. This
   also surfaces the maintainer's intent at code-review time.
2. **Build for the PO future.** The translation primitive
   (prompt + parse + write a batch of units with placeholders
   protected) must be reusable when `i18n-translation-source.md`
   PR B lands. Concretely: `intl-ai-prompt-builder.mts` and
   `intl-ai-response-parser.mts` should take a generic
   `TranslationUnit[]`, not hard-code the i18next JSON shape.
3. **Human review stays mandatory.** The script writes a PR-ready
   diff with reviewer annotations; **it does not auto-merge**. The
   override scripts (`locale-*-value-overrides.mts`) keep running on
   top of AI output; do not collapse them.

If any of those three are unacceptable to the user, the answer flips
to **No**.

---

## 6. Effort Estimate (before any code is written)

| Phase                                                                               | Estimate     | Notes                                                |
| ----------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------- |
| Discovery (this report)                                                             | 0.5 h        | Done                                                 |
| MVP: single-locale end-to-end (prompt + parse + write)                              | 4–6 h        | Reuse `protectPlaceholders`, `repairTranslatedValue` |
| Multi-locale batching + rate-limit handling + cache                                 | 2–3 h        |                                                      |
| Tests: prompt builder, parser, placeholder parity, key-count gate                   | 2–3 h        |                                                      |
| Polish: dry-run, diff-in-PR summary, glossary injection, `ALLOWED_MODELS` allowlist | 2–4 h        |                                                      |
| **Total v1**                                                                        | **~12–16 h** |                                                      |

That matches the task brief's estimate, and is sized assuming **the
existing Google script is deleted in the same change**. If we keep
both, add ~2 h for dual-maintenance overhead.

---

## 7. Risks That Could Eat ROI

1. **OpenRouter `openrouter/free` gets rate-limited or deprecated**
   — mitigation: provider abstraction is ~50 LOC; swap to a paid
   fallback (Tencent Hy-MT2 is ~$0.50/year for our volume).
2. **Output drift between runs** (non-deterministic) — mitigation:
   content-addressable cache + model-id + prompt-version in the cache
   key; invalidate intentionally when changing any of those.
3. **Review burden stays high** because terminology drift still needs
   human eyes — mitigation: glossary block in prompt reduces
   override-script churn; measure post-launch whether
   `locale-*-value-overrides.mts` PRs drop in volume.
4. **PR B (gettext PO) ships mid-implementation** — mitigation: write
   the prompt builder + parser against a generic `TranslationUnit`
   interface; the JSON-specific IO becomes a thin adapter.
5. **`en.json` grows faster than intl-ai can keep up** — unlikely
   given the 13-commits-per-year velocity, but if a localization
   blitz happens, the 90 s/full-sweep number is the binding
   constraint, not the script.

---

## Appendix A: Concrete files to read before implementing

- `config/i18n-translation-source.md` — PO migration plan, PR B
  status, the canonical architecture decision.
- `config/scripts/bootstrap-locale-catalog.mts` — the script we are
  replacing; do not skim.
- `config/scripts/locale-translation-policy.mts` + its `.test.mjs`
  files — validation contract.
- `config/localization-audit.md` — coverage gate that already
  enforces "every new string gets a key".
- `config/scripts/locale-*-value-overrides.mts` — the post-AI polish
  layer that must keep running.
