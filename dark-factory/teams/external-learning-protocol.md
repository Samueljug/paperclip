# External Learning And Improvement Protocol

Use this protocol whenever the Pi team calls external or adjacent review systems
such as Claude Code, no-mistakes, Webwright, dynamic workflows, security swarms,
browser QA tools, dependency auditors, targeted verifier passes, or external
model review.

The goal is not just to learn from failures. The team should also find patterns
where the system can become faster, clearer, cheaper, safer, or less repetitive.

## What To Log

Record an entry for every meaningful external or adjacent call that affects a
plan, implementation, gate, review, PR, or fix loop.

Log at least:

- Task id and run folder.
- Tool or system called.
- Agent that called it.
- Repo, branch, PR, or cwd.
- Prompt or command summary.
- Status, exit code, elapsed time, and cost/usage when available.
- Finding categories.
- Findings, false positives, missed issues, useful suggestions, and ignored
  suggestions.
- Follow-up action taken by Pi/OpenClaw.
- Whether the finding represents a one-off event, a possible pattern, or a
  confirmed repeated pattern.

The Claude bridge automatically appends metadata to:

```text
.pi/openclaw-teams/logs/external-agent-calls.jsonl
```

Agents should still write task-specific summaries under:

```text
.pi/openclaw-teams/runs/<task-id>/
```

Prefer bounded summaries, hashes, run ids, URLs, and file paths over raw long
transcripts. Do not log secrets, tokens, private credentials, or unnecessary
personal context. Pi external-learning memory is development-only; route
personal, general-assistant, reminder, life, or non-development facts to
OpenClaw memory instead.

## Categories

Use consistent category labels so patterns can be counted later:

- `external_agent`
- `claude_code`
- `no_mistakes`
- `webwright`
- `dynamic_workflow`
- `security`
- `review`
- `pre_pr`
- `post_pr`
- `pr_comments`
- `planning`
- `research`
- `source_fanout`
- `architecture_council`
- `parallel_isolation`
- `factory_cell`
- `cross_cell_contamination`
- `namespace`
- `firecrawl`
- `google_search`
- `x_grok`
- `gemini_cli`
- `codex_55_xhigh`
- `api_probe`
- `repo_probe`
- `musk_algorithm`
- `implementation`
- `verification`
- `targeted_verifier`
- `claim_verification`
- `unverified_gap`
- `browser_qa`
- `dependency`
- `policy`
- `skill`
- `efficiency`
- `cost`
- `false_positive`
- `missed_issue`
- `repeated_failure`
- `major_improvement`

Add a narrower label when it helps, but keep the broad labels above so the
self-improvement lead can group entries across tasks.

## Pattern Review

The self-improvement lead should periodically review the ledger, role memory,
project memory, task run notes, PR comments, and GBrain captures.

Look for:

- Repeated failure classes.
- Repeated manual steps that should become a checklist, command, script, skill,
  or protocol.
- Expensive external calls that did not change the outcome.
- External tools finding the same category of issue after Pi missed it.
- Targeted verifier reports with repeated `Could not verify` gaps, missing
  fixtures/scripts/oracles, weak evidence, or noisy checks.
- False positives that waste fix-loop time.
- Better routing decisions: which model, agent, worker, protocol, or evidence
  type should be used earlier or later.
- Gaps between Samuel's instructions and what agents actually did.
- Improvements that reduce latency, cost, user interruptions, review churn, or
  PR risk.

Do not wait for three identical failures when the impact is high. A single
high-severity or high-leverage observation can become an improvement proposal,
but it should be labelled as a `major_improvement` rather than a
`repeated_failure`.

## Improvement Gates

The system may do these automatically:

- Write local logs and task notes.
- Categorize findings.
- Update small factual development-only role/project memory.
- Capture durable development-only local notes to GBrain with `tag:
  pi-agent-teams` and `domain: development`, using `--source pi-development`
  when available.
- Send structured improvement requests to OpenClaw.
- Create pending Skill Workshop proposals through OpenClaw.

The system must not do these automatically unless Samuel explicitly approves or
the relevant repo/process already allows it:

- Apply or install a skill proposal.
- Change live OpenClaw/SOUL/AGENTS behavior beyond local task memory.
- Push to protected branches.
- Merge PRs before normal checks/reviews/comment gates pass.
- Relax security, privacy, repo routing, no-mistakes, evidence, or review
  gates.
- Give an external system broader cwd, credentials, or permissions.

Default stance: automatic observability and proposal generation; approval-gated
live system mutation.

## Pattern Summary Format

When escalating to OpenClaw or the self-improvement lead, use:

```markdown
External learning summary
Task/run ids:
Tools involved:
Categories:
Pattern status: one_off | possible_pattern | repeated_pattern | major_improvement
Evidence:
Observed friction or risk:
Suggested improvement:
Expected benefit: speed | quality | cost | safety | fewer interruptions | clearer ownership
Approval needed: none | memory_only | skill_proposal | policy_pr | live_tool_change
```
