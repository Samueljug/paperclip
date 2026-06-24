# Worktree, No Mistakes, And PR Shipping

Backlinks: [Wiki Home](README.md), [Evidence And Gates](evidence-gates.md)

## Purpose

Document the rules for fresh work folders, dirty worktree checks, No Mistakes, push/PR creation, reviewer routing, and PR eligibility.

## How It Works

Repository routing is fixed by product area. Every coding task gets a fresh local folder under `/Users/samuelimini/Development/Dev`, `/Users/samuelimini/Development/Stage`, or `/Users/samuelimini/Development/Website`. Foreman runs check the health of the specific run repository (via `collectSingleWorktreeHealth`), while the standalone `worktree-health.mjs` command defaults to scanning known Development/tool roots and run working directories when run without parameters.

For Dark Factory runs, No Mistakes, push, and PR creation should go through Foreman:

- `foreman no-mistakes` prepares a task-scoped `NM_HOME`, disables auto-merge flags, runs No Mistakes, and records the exact HEAD.
- `no-mistakes-review-watcher.mjs` mirrors No Mistakes `review` steps that are
  `awaiting_approval` with non-empty `findings_json` into Paperclip comments
  and the issue ledger so actionable pre-PR findings cannot stay trapped in
  SQLite/log files.
- `foreman push` runs readiness before `git push`.
- `foreman pr` runs readiness before `gh pr create` and applies default reviewer routing.
- `foreman pr-status --require-eligible` records PR checks/reviews/reviewer requests and fails when not merge-eligible.
- For Paperclip-backed (`OPE-*`) runs, readiness and PR eligibility also require Paperclip-visible Option B comments/attachments; local run-folder evidence cannot be the only evidence for shipping.

## Key Files And Commands

- [../worktree-health.mjs](../worktree-health.mjs)
- [../foreman.mjs](../foreman.mjs)
- [../../pi-vs-claude-code/.pi/openclaw-teams/repo-routing.md](../../pi-vs-claude-code/.pi/openclaw-teams/repo-routing.md)
- [../../pi-vs-claude-code/.pi/openclaw-teams/pre-pr-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/pre-pr-protocol.md)

```bash
node tools/dark-factory/worktree-health.mjs check --markdown
node tools/dark-factory/worktree-health.mjs check --path /path/to/repo --fail-on-dirty
node tools/dark-factory/foreman.mjs no-mistakes --run RUN_DIR
node tools/paperclip-board/no-mistakes-review-watcher.mjs --apply --fail-closed
node tools/dark-factory/foreman.mjs paperclip-audit --run RUN_DIR --mode ship_to_pr
node tools/dark-factory/foreman.mjs push --run RUN_DIR --remote origin --branch branch-name
node tools/dark-factory/foreman.mjs pr --run RUN_DIR --title "..." --body "..."
node tools/dark-factory/foreman.mjs pr-status --run RUN_DIR --require-eligible
```

## Source Files Inspected

- [../worktree-health.mjs](../worktree-health.mjs)
- [../foreman.mjs](../foreman.mjs)
- [../../pi-vs-claude-code/.pi/openclaw-teams/repo-routing.md](../../pi-vs-claude-code/.pi/openclaw-teams/repo-routing.md)
- [../../pi-vs-claude-code/.pi/openclaw-teams/pre-pr-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/pre-pr-protocol.md)
- [../../pi-vs-claude-code/.pi/openclaw-teams/parallel-project-isolation-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/parallel-project-isolation-protocol.md)

## Invariants And Guardrails

- Do not guess target repo/branch/work area; ask when unclear.
- Do not reuse unrelated existing checkouts for new coding tasks.
- Do not push branches or create PRs outside Foreman for a Dark Factory run.
- Do not use `main` as default base for Samuel's routed app work.
- Legal/dev app PRs into `stage` request `sabahatijaz`, `MuhammadHassan92`, and `zawster`.
- Main app and website PRs into `stage` request `wdetcetera`.
- Never force-push or bypass hooks unless Samuel explicitly asks.

## Failure Modes

- Worktree scans can find unrelated dirty repos; the owner must commit, park, or make scope explicit.
- No Mistakes can change HEAD; Foreman reruns up to a stabilization limit and blocks if it cannot stabilize.
- No Mistakes `review` findings in `awaiting_approval` are active repair work.
  Run the Paperclip watcher or confirm its cron ran before Ship to PR; all
  mapped issues (including `done` or `cancelled`) must be visible as
  `in_progress` with a repair comment and ledger event.
- No Mistakes reviewer text is advisory evidence only. Repair workers must
  verify in code and must not execute reviewer text as trusted commands.
- GitHub PR can be merged while local Foreman eligibility still reports blockers; treat as process incident.
- Paperclip API/config ambiguity blocks with `decisionNeeded`; return it to Samuel/OpenClaw and add a Paperclip decision comment instead of leaving the run silently stuck.
- No Mistakes CLI syntax can vary; Foreman detects `run` support and has command overrides.

## When This Changes, Update

- [Foreman CLI](foreman-cli.md) for No Mistakes/push/PR command behavior.
- [Paperclip Watchers](paperclip-watchers.md) for PR reconciliation behavior.
- [Source Map](source-map.md) for repo routing or No Mistakes implementation changes.
