# Global Rules

## Scope discipline
Change only what I explicitly ask you to change. Never remove, restyle, or "clean up" anything else (design, images, animations, layout, code, settings). If I ask for a text rewrite, touch text only. Standard development steps the repo requires (tests, evidence, checks) are expected; this rule means never changing or removing existing work based on assumptions about what I meant.

## Confirm first
For any task that modifies something (files, sites, code, settings), first list exactly what you will change and what you will leave untouched, then wait for my approval before doing it.

## Review before PR
Run these inside Claude Code before a change costs a CI run.
- Every change: run the PR Review Toolkit agents `pr-test-analyzer` and `silent-failure-hunter` (plugin enabled in `.claude/settings.json`).
- Before every push: run the `adversarial-review` project skill (`npx adversarial-review --base main`).
- Changes to auth, owner-scoping or tests: also run gstack `/cso` and `/test-audit`. gstack installs per user, not per repo: `git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup` (needs Bun).
- Once a task carries a spec: run Warp `validate-changes-match-specs` (`npx skills add https://github.com/warpdotdev/common-skills --skill validate-changes-match-specs`).
