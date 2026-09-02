---
tags:
  - orca
  - autoresearch
  - session-brief
---

# Session brief: start the orca-mem-rss autoresearch loop

## Where to start

- Worktree: `/Users/josocjoq/Documents/prjcts/_own/orca-mem-worktrees/memloop` (branch `exp/mem-autoresearch`)
- `.auto/` is already populated: `measure.sh`, `prompt.md`, `ideas.md`, `checks.sh`, `config.json` (maxIterations: 40), `log.jsonl` (1 baseline sanity run)
- Pinned baseline app: `~/Documents/prjcts/_own/orca-mem-worktrees/bench-bases/orca-mem-rss/Orca.app` (already built from commit `e9a9cee7`)
- Lane is clean: `git status` shows no uncommitted changes.

## Host state (re-baselined)

- Production Orca app: **closed** (this is new since the noise-floor baseline; expect lower variance now)
- Host-noise sources documented in `.agents/notes/host-noise-2026-08-30/` (daemon terminal leak, orphaned bench procs, long-run renderer growth). Before runs, sweep `pgrep -f orca-mem-worktrees` and kill orphans. Kill stale `orca-tcc-login`/zsh shells from the daemon (185 found, ~950MB).
- Old `.auto/log.jsonl` baseline run 0 measured `main_rss_delta_mb=+19.17MB` on this machine with prod Orca running — that's the prior noise floor. Do NOT trust that as the current floor; treat it as historical.

## What to do in this session

1. **Pre-run sweep** (cheap, no app changes):
   ```sh
   pgrep -f orca-mem-worktrees | xargs -r kill -9 2>/dev/null
   pgrep -fl "orca-tcc-login" | awk '{print $1}' | xargs -r kill -9 2>/dev/null
   pgrep -f "/orca-mem-worktrees\|/orca/dist" -fl Orca | awk '{print $1}' | xargs -r kill -9 2>/dev/null
   ```
2. **Verify lane is clean and tools work**:
   ```sh
   cd ~/Documents/prjcts/_own/orca-mem-worktrees/memloop
   git status                    # must be clean
   bash -n .auto/measure.sh      # syntax OK
   bash -n .auto/checks.sh       # syntax OK
   ```
3. **Run a fresh 3-run A/B baseline** (one measure.sh invocation):

   ```sh
   MEASURE_KEEP_ARTIFACTS=1 ./.auto/measure.sh 2>/tmp/measure-1.log
   ```

   - Expected wall time ~16-18 min (settle 120 + window 60, 3 runs, 6 spawns).
   - Captures the new noise floor now that prod Orca is closed.
   - Note the `main_rss_delta_mb` and the per-run medians in `/tmp/measure-1.log`.

4. **Update `.auto/log.jsonl`** with this run as run 1 (`status: discard`, noise-floor tag in asi). Use the same JSONL shape already there (the autoresearch plugin reads it back).
5. **Update `.auto/prompt.md` "What's Been Tried"** with the new floor so the loop agent knows the working baseline.
6. **Stop and hand back** — don't start iterating yet. The user wants to fold in the three host-noise fixes from `.agents/notes/host-noise-2026-08-30/` (in priority order) before the loop runs, then start it overnight.

## What NOT to do

- Don't run more than one baseline this session — the user explicitly wants one fresh floor, not several.
- Don't start iterating on memory optimizations yet. The user is folding host-noise fixes in first.
- Don't touch files outside `.auto/`, `config/scripts/build-bench-app.mjs`, `config/scripts/resource-metrics-analysis.mjs`, or the `.agents/notes/` research dir unless asked.
- Don't commit unless asked.

## If anything breaks

- `.auto/measure.sh` exits 2 with "baseline app not found" → confirm `~/Documents/prjcts/_own/orca-mem-worktrees/bench-bases/orca-mem-rss/Orca.app/Contents/MacOS/Orca` exists.
- electron-builder fails "verify-skills-cli-runtime missing entry" → that means the bench build forgot `build:relay` + `build:cli`; check `config/scripts/build-bench-app.mjs` (the fix is already committed).
- "Target page, context or browser has been closed" in the harness → CDP crash mid-snapshot, the run artifact is partial; this is a known issue and is the basis for research note `02-orphaned-bench-procs.md`. The measure.sh currently does not retry; let it finish and report.

## Reference

- Plan that staged this session: `~/.local/state/maki/plans/select-uncommon-lamprey.md`
- Handoff that fed the plan: `~/.local/state/maki/handoffs/orca-mem-obs-bisect.md`
- Memory tags for follow-up context: `orca`, `memory`, `autoresearch`, `host-noise`, `benchmarking`
- The plugin's session layout lives at `~/Documents/prjcts/_own/agentplugins-autoresearch/skills/autoresearch-create/SKILL.md` if anything in `.auto/` is unclear.
