# Pi Dynamic Workflows Protocol

Pi dynamic workflows are short-lived swarms for complex stages. They are not the
top-level Dark Factory runner.

Use the `workflow` tool when a task benefits from multiple fresh-context agents,
structured comparison, or an adversarial check. Keep the deterministic factory
state elsewhere: WorkOrder, manifest, evidence ledger, PR watcher, and final
gate decisions must not depend on hidden workflow state.

## Default Shape

- Use dynamic workflows from `pi-orchestrator`, team leads, and specialist
  verification/security/testing agents.
- Give each workflow a clear task id, budget, stop condition, and expected JSON
  output when possible.
- Pass only the minimum context required. Do not dump entire private memory or
  secrets into a workflow prompt.
- Respect the memory boundary: Pi workflow prompts and outputs should contain
  development-only memory. Route personal or general OpenClaw context back to
  OpenClaw memory instead of persisting it in Pi outputs.
- Prefer fresh-context subagents for judgment, review, scenario generation, and
  independent reproduction.
- Save important outputs into the task run folder or final evidence pack.

## Patterns

### Classify And Act

Use for routing and triage:

- Identify target repo, branch, work area, and risk class from an intake brief.
- Classify PR comments into actionable, informational, resolved, product
  question, security risk, or CI noise.
- Decide which factory gates are required for a change.

### Fan Out And Synthesize

Use for parallel discovery and review:

- Ask several agents to inspect different parts of a codebase.
- Run multi-perspective design, test, security, or domain review.
- Compare frontend, backend, QA, and security concerns before a plan is accepted.

### Adversarial Verification

Use when confidence matters:

- Have one agent argue why the change is incomplete or unsafe.
- Challenge pre-PR evidence, browser screenshots, and claimed test coverage.
- Use a blind judge against acceptance criteria or holdout scenarios when
  available.

### Generate And Filter

Use to create candidate artifacts, then select the best:

- Acceptance criteria and business-flow test ideas.
- Edge cases, seeded scenarios, Webwright flows, and fixture plans.
- Refactor options, UI variants, migration plans, and skill/policy proposals.

### Tournament

Use when there are several plausible approaches:

- Compare implementation plans.
- Compare test strategies.
- Compare UI/business-flow validation strategies.
- Pick the winner using explicit criteria: correctness, maintainability,
  safety, testability, and alignment with Samuel's dev policy.

### Research And Architecture Council

Use for large ideas before implementation planning:

- Generate a bounded source plan for Firecrawl/docs crawling, Google/web search,
  X/Grok, Gemini CLI, Claude Code, Codex 5.5 extra-high, API probing, and repo
  inspection.
- Synthesize source notes into a research dossier with verified facts,
  contradictions, unavailable adapters, and open gaps.
- Run independent architecture proposals and adversarial critiques.
- Apply the Musk algorithm in order: question requirements, delete, simplify,
  accelerate cycle time, then automate.
- Return a decision record, not just a brainstorm.

The workflow can help structure the fan-out and council, but source calls that
need shell, web, X, API, Claude Code, or Gemini access must be executed by the
owning lead/tool path and saved into the run folder.

### Loop Until Done

Use only with a cap and a gate:

- Fix failing tests until green.
- Reproduce and fix a browser bug.
- Process actionable PR comments until resolved.
- Improve a plan until adversarial review stops finding material blockers.

Always set a maximum number of iterations and escalate to OpenClaw or Samuel
when the loop keeps failing, the required decision is ambiguous, or the change
becomes too risky.

## When Not To Use

- Simple one-file fixes.
- Deterministic shell commands, installs, builds, or status checks.
- Long-running resumable workflows; use the Dark Factory runner/ledger instead.
- Global service management or destructive operations.
- Unbounded recursive delegation.
- PR merge decisions; use GitHub checks, reviews, comments, and the PR protocol.

## Skill And Policy Learning

Dynamic workflow outputs can recommend new skills or policy updates, but they do
not install them directly.

When a workflow reveals a repeated failure or major reusable improvement,
collect the evidence and follow `.pi/openclaw-teams/review-to-skill-protocol.md`.
OpenClaw creates pending Skill Workshop proposals, and dev-policy improvements
go through a focused PR to `aila-code/devpolicy-legal`.
