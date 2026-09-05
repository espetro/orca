# Backlog Policy

All agent work in this repo must be linked to a refined task in the project's
tracker (GitHub Project, managed with the `ghx` CLI). No orphan work: do not
start implementation without a refined task, and do not create work that is not
tracked.

## Project Management

- All plans and implementations must be linked to a refined task in the
  Project (usually GitHub Project, but could also be Linear, local project,
  etc.).
- If no GitHub Project is set for the project, raise it and ask the user to set
  up a GitHub project and share the URL. Then keep it in the project's
  AGENTS.md so next iterations don't miss it.
- Use the `ghx` CLI to manage the project.

## Definition of Refined

A task is **refined** when it has all of the following:

1. **Iteration/Quarter set** -> maps to a roadmap milestone in
   [`docs/prd.md`](../docs/prd.md)
2. **Effort estimate** (S/M/L/XL) -> includes testing + bug potential per
   contact surface
3. **Start date + Target date** -> scheduled in the roadmap
4. **Classification label** (`feature` / `bug` / `cosmetic` / `infra`) ->
   drives client positioning

## Plans

- All agent plans go to `<PROJECT_ROOT>/.agents/plans/<date>-<purpose>.md`.
  Example: `.agents/plans/2026-06-01-setup-auth.md`
- Plans must exist on disk before implementation begins.

## Commits

- Atomic commits: each commit contains just one self-contained logical change.
  For example, if a feature/fix changes multiple components of a pipeline, with
  atomic commits each commit would tackle the changes for a single pipeline
  component.
- Conventional commit format: https://www.conventionalcommits.org/en/v1.0.0/
- Never set a co-author in commit messages.
