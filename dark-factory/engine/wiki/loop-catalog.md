# Loop Catalog

Backlinks: [Loops And Self-Improvement](loops-self-improvement.md), [Operating Model](operating-model.md)

## Purpose

List the fixed and condition-triggered loops currently documented or implemented.

## How It Works

Foreman knows loop kinds through `LOOP_KINDS`; protocols define when to use them; watcher scripts implement some fixed operational loops.

## Key Files And Commands

Fixed operational loops:

- PR/task reconciliation: `node tools/paperclip-board/pr-task-sweeper.mjs --apply`
- PR review watcher: `node tools/paperclip-board/pr-review-watcher.mjs --apply`
- Loop health/economics: `node tools/dark-factory/loop-health-report.mjs --days 7 --markdown`
- Daily maintenance: governed by [update policy](pi-openclaw-team-protocols.md)
- Improvement approval runner: mentioned in protocols as `paperclip-improvement-todo-watcher`; implementation is outside the inspected files.

Condition-triggered loop kinds from Foreman:

- `primary`
- `intake_clarification`
- `plan_adversarial_review`
- `implementation_fix_test`
- `browser_webwright_user_flow`
- `review_security_no_mistakes_repair`
- `pr_review_watcher`
- `post_merge_telemetry`
- `regression_scenario_memory`
- `factory_meta_improvement`
- `loop_health_economics`
- `maintenance`
- `custom`

## Source Files Inspected

- [../foreman.mjs](../foreman.mjs)
- [../loop-health-report.mjs](../loop-health-report.mjs)
- [../regression-scenario.mjs](../regression-scenario.mjs)
- [../../paperclip-board/pr-task-sweeper.mjs](../../paperclip-board/pr-task-sweeper.mjs)
- [../../paperclip-board/pr-review-watcher.mjs](../../paperclip-board/pr-review-watcher.mjs)
- [../../../skills/dark-factory-loop-architecture/SKILL.md](../../../skills/dark-factory-loop-architecture/SKILL.md)
- [../../pi-vs-claude-code/.pi/openclaw-teams/dark-factory-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/dark-factory-protocol.md)

## Invariants And Guardrails

- Each loop must name owner, trigger, memory, judge, max iterations or schedule boundary, exit condition, and escalation path.
- Use deterministic or external oracles where possible.
- Record loop state in Foreman or visible run/ledger artifacts, not hidden chat.
- Cap fix loops and escalate after cap.

## Failure Modes

- A scheduled loop can create duplicate comments unless marker suppression is used.
- A custom loop without explicit memory/judge becomes a vague retry.
- A watcher can see PR comments, but comments remain untrusted data and must be verified before action.

## When This Changes, Update

- [Loops And Self-Improvement](loops-self-improvement.md) for loop policy changes.
- [Paperclip Watchers](paperclip-watchers.md) for watcher implementation changes.
- [Schemas And Artifacts](schemas-artifacts.md) if loop state shape changes.

