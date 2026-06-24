# Loops And Self-Improvement

Backlinks: [Wiki Home](README.md), [Loop Catalog](loop-catalog.md)

## Purpose

Document bounded Dark Factory loops and how failures become durable improvement work.

## How It Works

Loops are explicit, bounded mechanisms with owner, trigger, memory, judge, max iterations or schedule boundary, exit condition, escalation, and visible output. Foreman stores the primary loop and optional `loops[]` in the run manifest. `foreman iterate` increments loop state, records a ledger event, and blocks the run when a loop exhausts or becomes blocked.

Self-improvement is mandatory run coverage. Every Dark Factory run must record an improver review before Ship to PR, Done, closed, or any final disposition. If there is no reusable lesson, the improver records a visible no-op review. If the run is truly not applicable, the result still records `improvement_not_applicable` with owner and reason.

Self-improvement flows use:

- `improver_review` evidence and the `self_improvement` Foreman gate.
- Paperclip-visible `improvement_review`, `improvement_noop`, or `improvement_not_applicable` comments for Paperclip-backed work.
- Regression scenarios in `tools/paperclip-data/regression-scenarios/scenarios.jsonl`.
- Improvement reports in the Paperclip `Improvement Reports` project.
- Review-to-skill protocol for repeated failures or major reusable improvements.
- Loop health reports for stale runs, exhausted loops, repeated blockers, gate failures, and dirty worktrees.

## Key Files And Commands

- [../foreman.mjs](../foreman.mjs)
- [../loop-health-report.mjs](../loop-health-report.mjs)
- [../regression-scenario.mjs](../regression-scenario.mjs)
- [../../paperclip-board/create-improvement-report.mjs](../../paperclip-board/create-improvement-report.mjs)
- [../../pi-vs-claude-code/.pi/openclaw-teams/review-to-skill-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/review-to-skill-protocol.md)
- [../../../skills/dark-factory-loop-architecture/SKILL.md](../../../skills/dark-factory-loop-architecture/SKILL.md)

```bash
node tools/dark-factory/foreman.mjs iterate --run RUN_DIR --loop implementation-fix-test --verdict FAIL --summary "..."
node tools/dark-factory/foreman.mjs loop-summary --run RUN_DIR
node tools/dark-factory/foreman.mjs evidence --run RUN_DIR --kind improver_review --path reports/improver-noop-review.md --summary "improver no-op review"
node tools/dark-factory/foreman.mjs record-gate --run RUN_DIR --gate self_improvement --verdict PASS --summary "improver review complete" --details-json '{"improverVerdict":"noop","owner":"self-improvement-lead","sourceCoverage":["ledger","run artifacts"],"missingCoverage":"none"}' --path reports/improver-noop-review.md
node tools/dark-factory/loop-health-report.mjs --days 7 --markdown
node tools/dark-factory/regression-scenario.mjs add --issue OPE-123 --kind webwright --summary "..." --trigger "..." --reproduction "..." --verification "..."
node tools/paperclip-board/create-improvement-report.mjs --source OPE-123 --summary "..."
```

## Source Files Inspected

- [../foreman.mjs](../foreman.mjs)
- [../loop-health-report.mjs](../loop-health-report.mjs)
- [../regression-scenario.mjs](../regression-scenario.mjs)
- [../../paperclip-board/create-improvement-report.mjs](../../paperclip-board/create-improvement-report.mjs)
- [../../../skills/dark-factory-loop-architecture/SKILL.md](../../../skills/dark-factory-loop-architecture/SKILL.md)
- [../../pi-vs-claude-code/.pi/openclaw-teams/review-to-skill-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/review-to-skill-protocol.md)
- [../../pi-vs-claude-code/.pi/openclaw-teams/memory/projects/dark-factory.md](../../pi-vs-claude-code/.pi/openclaw-teams/memory/projects/dark-factory.md)

## Invariants And Guardrails

- No unbounded loops.
- Loop exhaustion becomes a blocker and an improvement finding.
- Loops may create proposals or tickets, but live policy/skill/tool changes still require Samuel approval or an approved task path.
- An improver no-op is explicit evidence, not an omitted lane.
- Implementation WorkOrders must include exactly one one-shot `plan_adversarial_review` loop.
- Product/competitor opportunity loops are out of scope until Samuel approves that source-monitoring lane.

## Failure Modes

- A loop recorded only in prose is hard for Foreman to enforce.
- Repeated blocker comments without a liveness decision can make a task look active while nothing is executing.
- Regression scenario memory can overfit if it records only visible paths and no holdout/adversarial variants.
- At inspection time `tools/paperclip-data/regression-scenarios/scenarios.jsonl` was not present, so regression memory is a current setup gap until the first scenario is recorded or the path is created.
- Improvement reports are proposals while in Backlog; actioning them before approval violates the approval queue.
- Closing or shipping a run before the improver gate/comment exists recreates the OPE-202/OPE-248 failure mode and must be treated as a process blocker.

## When This Changes, Update

- [Loop Catalog](loop-catalog.md) when loop types or scheduled loops change.
- [Paperclip Integration](paperclip-integration.md) when improvement report status/labels change.
- [Pi/OpenClaw Team Protocols](pi-openclaw-team-protocols.md) when review-to-skill or memory routing changes.
