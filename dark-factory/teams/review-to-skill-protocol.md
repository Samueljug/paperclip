# Review-To-Skill Protocol

Pi agents use this protocol when review, verification, security, no-mistakes,
external-learning logs, Claude Code, Webwright, dynamic workflows, dependency
audits, or PR comment handling find a repeated failure pattern or a major
improvement opportunity.

Pi agents usually do not have OpenClaw's `skill_workshop` tool directly. Their
job is to detect and document the pattern, then escalate a structured skill
proposal request to `self-improvement-lead` and OpenClaw.

Before creating a new Skill Workshop proposal, revising a pending proposal, or
updating an existing live skill, follow
`.pi/openclaw-teams/claude-skill-evaluator-protocol.md` unless the change is a
tiny typo, formatting, or metadata-only edit.

## When To Escalate

Escalate when one or more of these are true:

- The same class of mistake appears across multiple tasks, PRs, review
  comments, no-mistakes findings, external-agent findings, or fix loops.
- A worker or lead fails to solve the same problem after repeated attempts.
- A review identifies a high-impact process improvement that should become a
  reusable checklist, procedure, script, or guardrail.
- A task required a complex manual sequence that future agents are likely to
  repeat incorrectly.
- Existing docs, prompts, or skills were too vague to prevent the failure.
- External or adjacent tools repeatedly find issues only after Pi misses them.
- The same external call is expensive, noisy, redundant, or avoidable across
  multiple tasks.
- A single finding is high-leverage enough to improve speed, quality, cost,
  safety, routing, or user-interruption rate.

Do not create a skill request for a one-off bug, a simple project fact that
belongs in memory, or something already covered by a clear existing rule.

## Evidence To Collect

Collect enough evidence for OpenClaw to create or update a skill:

- Pattern or failure type.
- Task id, PR URL, review comment URL, no-mistakes run id, files, commands, or
  logs.
- External-learning ledger entries, categories, run ids, tool names, and
  bounded output summaries.
- What the agent tried and why it failed or was inefficient.
- Why existing instructions were insufficient.
- Proposed reusable behavior: checklist, workflow, script, or guardrail.
- Whether this should be a new skill, an update to an existing skill, or just a
  memory/protocol update.
- Claude skill evaluator output, or a clear reason the evaluator was skipped or
  unavailable.
- For updates, a preservation audit comparing the current skill/proposal to the
  proposed version.

## Update Preservation Rule

Skill updates are merge-preserving by default.

Do not remove, weaken, rename, or hide existing triggers, workflows, guardrails,
examples, references, tool restrictions, safety rules, output formats, or
operating boundaries unless Samuel explicitly asked for that removal.

For any update to an existing live skill or pending proposal:

1. Read the current version first.
2. Draft the update as an additive merge.
3. Run the Claude skill evaluator against current vs proposed content.
4. List every removed, weakened, renamed, or unclear behavior.
5. If any material behavior would be lost, stop and ask Samuel before
   proceeding, or revise the proposal to preserve it.
6. Include the evaluator summary and preservation audit in the Skill Workshop
   evidence or task notes.

## Request Format

Send this to `self-improvement-lead`:

```markdown
Skill proposal request
Pattern: <repeated failure or improvement>
Evidence: <task ids, PR URLs, review comments, no-mistakes run ids, files, commands>
Impact: <why this matters>
Suggested skill/update: <new skill name or existing skill to update>
Proposed workflow: <short ordered steps>
Claude evaluator: <PASS | NEEDS_CHANGES | BLOCKED | unavailable/skipped with reason>
Preservation audit: <for updates, what was preserved/expanded/changed/removed>
Urgency: low | medium | high
```

## Self-Improvement Lead Duties

The self-improvement lead should:

1. Deduplicate similar requests.
2. Check whether existing Pi memory, OpenClaw memory, protocol docs, or skill
   proposals already cover the issue.
3. Review external-learning logs for related entries before deciding whether the
   issue is one-off, a possible pattern, a repeated pattern, or a major
   improvement.
4. If the issue is reusable and material, escalate to OpenClaw with the request
   block and evidence.
5. Ensure Claude skill evaluator output is attached or summarized before
   OpenClaw creates, revises, or updates a Skill Workshop proposal.
6. For updates, reject any proposal that loses existing behavior without
   Samuel's explicit approval.
7. Record any resulting Skill Workshop proposal id in role/project memory and
   the task run notes.
8. Decide whether the lesson should also update the core dev policy repo
   `https://github.com/aila-code/devpolicy-legal` on branch `dev`.
9. If policy should change, ask OpenClaw to open a narrow policy PR using a
   fresh clone under `/Users/samuelimini/Development/Dev`.
10. Keep the skill proposal pending unless Samuel explicitly approves applying
   or installing it.

## Core Dev Policy Updates

Samuel's core development policy repo is:

```text
https://github.com/aila-code/devpolicy-legal
branch: dev
```

If a repeated failure or major reusable improvement should become shared
development policy, propose a focused update to that repo. Use the normal fresh
folder rule, branch from `dev`, and open a PR back to `dev`. Do not push
directly to `dev` unless Samuel explicitly asks.

## Current Skill Workshop Proposals

- `samuel-pr-lifecycle-20260606-05a459f52f`: PR lifecycle, pre-PR checks,
  reviewer routing, post-PR comment loop, and website merge rule.
- `review-to-skill-20260606-355419a22c`: turn repeated failures or major review
  lessons into pending Skill Workshop proposals with evidence.
- `dev-policy-adherence-20260606-35843e6952`: use Samuel's
  `aila-code/devpolicy-legal` repo as the core coding policy source.
- `external-agent-learning-ledger-20260606-17df58be47`: log and categorize
  external/adjacent tool results, find patterns, and propose approval-gated
  system improvements.
- `claude-opus-planning-default-20260606-27e9bdd3af`: route extensive planning
  to Claude Code by default and enforce `claude-opus-4-8` with `effort=max`.
