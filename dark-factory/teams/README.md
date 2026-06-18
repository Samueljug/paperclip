# OpenClaw Multi-Team Pi Harness

This is Samuel's OpenClaw coding team scaffold.

OpenClaw remains the top-level orchestrator. The visible Pi layer is a team
network:

1. `pi-orchestrator` receives delegated coding missions from OpenClaw.
2. Team leads coordinate planning, implementation, verification, browser QA,
   security, release, and self-improvement.
3. Workers execute specialist tasks and report back to their lead.
4. Leads talk to each other through `coms_net_send` / `coms_net_await`.
5. Every task ends with verification, security review, and learning capture.

The network runs on the existing `coms-net` hub. Each agent is a normal Pi
process with the `coms-net` extension loaded, so leads and workers can pass work
sideways or upward without OpenClaw micromanaging every message.

## Launch

From the repo root:

```bash
scripts/openclaw-team.sh core
scripts/openclaw-team.sh problem
scripts/openclaw-team.sh full
scripts/openclaw-team.sh status
scripts/openclaw-team.sh stop
```

The launcher loads a model preset before resolving lane defaults. The default
preset is `claude-default`:

```bash
scripts/openclaw-team.sh status
OPENCLAW_PI_MODEL_PRESET="claude-default" scripts/openclaw-team.sh full
OPENCLAW_PI_MODEL_PRESET="codex-default" scripts/openclaw-team.sh full
```

Preset files live under:

```text
.pi/openclaw-teams/model-presets/
```

Explicit environment variables still win over preset values. For example, this
keeps `claude-default` for every other lane while overriding only ordinary
workers:

```bash
OPENCLAW_PI_MODEL_PRESET="claude-default" \
OPENCLAW_PI_MODEL_WORKER="openai-codex/gpt-5.5:xhigh" \
scripts/openclaw-team.sh full
```

`core` launches:

- Pi orchestrator
- Planning lead
- Implementation lead
- Research lead
- Verification lead
- Browser QA lead
- Security lead
- Self-improvement lead

`full` launches the core team plus workers:

- Problem solving lead
- Problem root cause solver
- Problem implementation solver
- Problem test/repro solver
- Problem risk skeptic
- Problem synthesis judge
- Product planner
- Architecture planner
- Frontend implementer
- Backend implementer
- Test engineer
- Browser tester
- Visual QA
- Security reviewer
- Dependency auditor
- Docs/release specialist
- Memory librarian

`claude-default` is the current default. It keeps persistent Pi shells on the
OpenAI Codex provider for controllers/leads, including the self-improvement
lead and memory librarian controller shells, and uses Claude Sonnet for ordinary
worker Pi shells. Opus-required substantive work still goes through the Claude
Code bridge at Claude Opus 4.8 max; for the self-improvement team that means
both `self-improvement-lead` and `memory-librarian` must use
`claude_code_run` with `claude-opus-4-8` and `effort=max` for substantive work:

```bash
OPENCLAW_PI_MODEL_CONTROLLER="openai-codex/gpt-5.5:xhigh"
OPENCLAW_PI_MODEL_ORCH="openai-codex/gpt-5.5:xhigh"
OPENCLAW_PI_MODEL_LEAD_CONTROLLER="openai-codex/gpt-5.5:xhigh"
OPENCLAW_PI_MODEL_PLANNING="openai-codex/gpt-5.5:xhigh"
OPENCLAW_PI_MODEL_ARCHITECT="openai-codex/gpt-5.5:xhigh"
OPENCLAW_PI_MODEL_SECURITY="openai-codex/gpt-5.5:xhigh"
OPENCLAW_PI_MODEL_WORKER="anthropic/claude-sonnet-4-5:high"
OPENCLAW_PI_MODEL_RESEARCH_LEAD="openai-codex/gpt-5.5:xhigh"
OPENCLAW_PI_MODEL_RESEARCH_WORKER="anthropic/claude-sonnet-4-5:high"
OPENCLAW_PI_MODEL_PROBLEM_LEAD="openai-codex/gpt-5.5:xhigh"
OPENCLAW_PI_MODEL_PROBLEM_WORKER="anthropic/claude-sonnet-4-5:high"
OPENCLAW_PI_MODEL_SELF_IMPROVEMENT_LEAD="openai-codex/gpt-5.5:xhigh"
OPENCLAW_PI_MODEL_SELF_IMPROVEMENT_WORKER="openai-codex/gpt-5.5:xhigh"
OPENCLAW_PI_MODEL_DOCS_RELEASE_LEAD="openai-codex/gpt-5.5:xhigh"
OPENCLAW_PI_MODEL_MEMORY_WORKER="openai-codex/gpt-5.5:xhigh"
OPENCLAW_CLAUDE_BRIDGE_ENABLED="1"
OPENCLAW_CLAUDE_BRIDGE_MODEL="claude-opus-4-8"
OPENCLAW_CLAUDE_BRIDGE_EFFORT="max"
```

`codex-default` preserves the previous Codex-led setup. The Claude Code bridge
stays enabled for explicit Claude-native passes, but the default Pi team lanes
are Codex-led. The self-improvement team, including `self-improvement-lead` and
`memory-librarian`, defaults to Codex GPT-5.5 xhigh:

```bash
OPENCLAW_PI_MODEL_CONTROLLER="openai-codex/gpt-5.5:xhigh"
OPENCLAW_PI_MODEL_ORCH="openai-codex/gpt-5.5:xhigh"
OPENCLAW_PI_MODEL_LEAD="openai-codex/gpt-5.5:xhigh"
OPENCLAW_PI_MODEL_PLANNING="openai-codex/gpt-5.5:xhigh"
OPENCLAW_PI_MODEL_WORKER="openai-codex/gpt-5.5:xhigh"
OPENCLAW_PI_MODEL_RESEARCH="openai-codex/gpt-5.5:xhigh"
OPENCLAW_PI_MODEL_ARCHITECT="openai-codex/gpt-5.5:xhigh"
OPENCLAW_PI_MODEL_SECURITY="openai-codex/gpt-5.5:xhigh"
OPENCLAW_PI_MODEL_SELF_IMPROVEMENT="openai-codex/gpt-5.5:xhigh"
OPENCLAW_PI_MODEL_SELF_IMPROVEMENT_WORKER="openai-codex/gpt-5.5:xhigh"
OPENCLAW_PI_MODEL_MEMORY_WORKER="openai-codex/gpt-5.5:xhigh"
OPENCLAW_PI_MODEL_PROBLEM="openai-codex/gpt-5.5:xhigh"
OPENCLAW_CLAUDE_BRIDGE_ENABLED="1"
OPENCLAW_CLAUDE_BRIDGE_MODEL="claude-opus-4-8"
OPENCLAW_CLAUDE_BRIDGE_EFFORT="max"
```

Set these additional environment variables to override other launcher defaults:

```bash
OPENCLAW_WEBWRIGHT_ROOT="$HOME/.openclaw/workspace/tools/webwright"
OPENCLAW_WEBWRIGHT_SKILL="$HOME/.openclaw/workspace/tools/webwright/skills/webwright"
OPENCLAW_CLAUDE_BRIDGE_ENABLED="1"
OPENCLAW_CLAUDE_BRIDGE_EXTENSION="extensions/claude-code-bridge.ts"
OPENCLAW_CLAUDE_BRIDGE_MODEL="claude-opus-4-8"
OPENCLAW_CLAUDE_BRIDGE_EFFORT="max"
OPENCLAW_PI_DYNAMIC_WORKFLOWS_ENABLED="1"
OPENCLAW_PI_DYNAMIC_WORKFLOWS_EXTENSION="/opt/homebrew/lib/node_modules/pi-dynamic-workflows/extensions/workflow.ts"
PI_COMS_NET_AUTH_TOKEN="devtoken"
PI_COMS_NET_PORT="52965"
```

For parallel project streams, launch one namespaced team per factory cell:

```bash
OPENCLAW_PI_TEAM_NAMESPACE="stage-main-20260606" scripts/openclaw-team.sh full
OPENCLAW_PI_TEAM_NAMESPACE="website-20260606" scripts/openclaw-team.sh full
OPENCLAW_PI_TEAM_NAMESPACE="dev-legal-20260606" scripts/openclaw-team.sh full
```

The namespace changes the default `PI_COMS_NET_PROJECT`, tmux session prefix,
hub session, and hub port. The default un-namespaced team remains
`project=openclaw`, prefix `pi-team`, and port `52965`.

Model variables are split by lane:

- `OPENCLAW_PI_MODEL_CONTROLLER` and the lead/security/planning controller
  overrides select the Pi shell/provider model used to host persistent agents
  and tools. This is not the substantive Opus policy lane.
- `OPENCLAW_CLAUDE_BRIDGE_MODEL` and `OPENCLAW_CLAUDE_BRIDGE_EFFORT` select
  the Claude Code bridge lane. Defaults are `claude-opus-4-8` and `max`.
- `OPENCLAW_PI_MODEL_WORKER`, `OPENCLAW_PI_MODEL_RESEARCH_WORKER`,
  `OPENCLAW_PI_MODEL_PROBLEM_WORKER`, and
  `OPENCLAW_PI_MODEL_SELF_IMPROVEMENT_WORKER` select worker Pi models by lane.
  `memory-librarian` uses the self-improvement worker lane, not the ordinary
  worker lane. `OPENCLAW_PI_MODEL_MEMORY_WORKER` remains a compatibility
  override for that role when `OPENCLAW_PI_MODEL_SELF_IMPROVEMENT_WORKER` is not
  explicitly set. `OPENCLAW_PI_MODEL_RESEARCH`,
  `OPENCLAW_PI_MODEL_PROBLEM`, and `OPENCLAW_PI_MODEL_SELF_IMPROVEMENT` also
  apply to their worker lanes unless the split worker overrides are set.

The launcher checks that the Pi auth provider for each shell model exists in
`~/.pi/agent/auth.json` before launching that role. Claude Code subscription
auth is not a normal Pi provider and must not be documented or configured as
one; it is used only through `extensions/claude-code-bridge.ts` and
`claude_code_run`.

Project/team leads, planning roles, security roles, and the self-improvement
team still launch as Pi agents, but their substantive
lead/planning/review/coordination/memory-improvement work must use Claude Code
Opus 4.8 max through `claude_code_run` when `claude-default` is selected. The
launcher refuses to start those Opus-required roles when the bridge is disabled,
missing, or the local Claude CLI is unavailable, rather than silently falling
back to the Pi controller shell model.

## Operating Rules

Repository and local-folder routing rules live in:

```text
.pi/openclaw-teams/repo-routing.md
```

In short: every coding task must use a fresh folder under the correct
`/Users/samuelimini/Development/{Dev,Stage,Website}` parent. If the target
product, repo, branch, or work area is unclear, ask Samuel through OpenClaw
before coding.

Core development policy rules live in:

```text
.pi/openclaw-teams/dev-policy-protocol.md
```

The source of truth is `https://github.com/aila-code/devpolicy-legal` on branch
`dev`. Agents must adhere to that policy for significant coding, review,
security, PR, and policy-improvement work. When the team learns a better
reusable practice, propose a focused update to the policy repo using the normal
fresh-clone and PR workflow.

Dark Factory pilot rules live in:

```text
.pi/openclaw-teams/dark-factory-protocol.md
```

The pilot starts with `aila-code/frontend-legal` and
`aila-code/backend-legal`, using `/Users/samuelimini/Development/Dev` as the
local parent and `stage` as the routed PR base / merge target. The website repo
`aila-code/aila-website` on `stage`, especially root `DESIGN.md`, is the current
design-principles source. Simple visual/responsive changes require screenshots;
functional frontend/backend/API or business-flow changes require video plus
tests/API evidence. Implementing agents do not review their own work as the only
review pass.

Dark Factory code, protocol, schema, prompt, runner, or WorkOrder behavior
changes also carry a wiki gate: update
`<FORK>/dark-factory/engine/wiki/` or record a
ticket-visible no-doc-needed reason before PR handoff or Done.

Parallel project isolation rules live in:

```text
.pi/openclaw-teams/parallel-project-isolation-protocol.md
```

For simultaneous Stage, Website, Dev, or other multi-project work, do not rely on
one shared team context. Create a separate factory cell per stream: namespace,
project id, session prefix, hub/port when needed, fresh work folder, repo
clone(s), branch/base, run folder, manifest, ledger, evidence, and scoped tool
state. Evidence, research, PRs, branches, and verifier results from one cell do
not count for another unless explicitly imported and labelled. This is the path
to unbounded-by-design parallelism; actual concurrency is still bounded by local
machine, model, browser, GitHub, and review capacity.

Research and architecture rules live in:

```text
.pi/openclaw-teams/research-architecture-protocol.md
```

For large ideas, ambiguous product direction, multi-repo work, external facts,
or major architecture, route through `research-lead` before implementation
planning. The research lane fans out to available source adapters such as
Firecrawl/docs crawling, Google/web search, X/Grok or `xurl`, Gemini CLI,
Claude Code, Codex 5.5 extra-high, direct API probes, and repo inspection. It
must produce a bounded research dossier with verified facts, contradictions,
unavailable adapters, and open gaps. The architecture planner then runs an
adversarial council: Claude Code and Codex 5.5 extra-high should independently
challenge the architecture, with a skeptic/verifier pass, before the final
decision is accepted. The final architecture must apply the five-step algorithm:
question requirements, delete, simplify/optimize, accelerate cycle time, and
automate only after the earlier steps.

Hard implementation/debugging problem rules live in:

```text
.pi/openclaw-teams/hard-problem-council-protocol.md
```

For D3/D4 implementation decisions, ambiguous root cause, repeated failed
verification/security/browser/No Mistakes loops, or explicit hard-problem
requests, route through the Problem Solvers group. The group is designed to
produce independent solution proposals first, then adversarial discussion, then
a typed `hard-problem-decision.md` handoff for implementation. It is not a
consensus chat and it does not replace normal verification or PR gates.

Targeted verifier rules live in:

```text
.pi/openclaw-teams/verifier-contract-protocol.md
```

For high-risk or complex coding tasks, run an independent verifier-contract pass
before no-mistakes/pre-PR. The verifier decomposes the work into atomic claims,
checks each claim against evidence, records what could not be verified, sends
corrective feedback, and uses the PERFECT/VERIFIED/PARTIAL/FEEDBACK/FAILED
verdict ladder. This borrows the useful pattern from `disler/the-verifier-agent`
without installing its always-on one-builder/one-verifier harness into the core
team.

Pre-PR and post-PR rules live in:

```text
.pi/openclaw-teams/pre-pr-protocol.md
```

Before any GitHub push or PR creation, the team must run the pre-PR quality gate
and No Mistakes validation against the exact head SHA and correct base branch.
No Mistakes is the intended pre-GitHub push gate, but factory runs must route
shipping through Foreman so the gate is mechanical for Pi/Codex paths, not just
prompt discipline. Foreman must run simulated CI/configured reviewers and record
a typed gate result before the branch reaches GitHub. For multi-repo tasks,
every touched repo needs a PR URL or an explicit no-PR-needed decision. Local
checks must mirror the repo's actual CI workflow where practical; targeted tests
are not enough when GitHub will run broader lint, unit, build, or integration
gates.
After a PR exists, an agent must watch review comments and CI checks, classify
failures, and keep fixing actionable/main items until they are resolved or
Samuel explicitly waives them.

Repeated-failure and skill-creation escalation rules live in:

```text
.pi/openclaw-teams/review-to-skill-protocol.md
```

When review, no-mistakes, verification, security, or PR comment handling finds a
repeated mistake or high-impact workflow improvement, agents should collect
evidence and send a structured skill proposal request to `self-improvement-lead`.
OpenClaw creates pending Skill Workshop proposals; new skills are not installed
or applied until Samuel explicitly approves that separate step.

External learning and improvement observability rules live in:

```text
.pi/openclaw-teams/external-learning-protocol.md
```

External and adjacent systems such as Claude Code, no-mistakes, Webwright,
dynamic workflows, security swarms, dependency auditors, and external model
review should be logged and categorized when they influence a plan, gate,
review, PR, or fix loop. The Claude bridge automatically appends bounded call
metadata to `.pi/openclaw-teams/logs/external-agent-calls.jsonl`. The default
stance is automatic observability and proposal generation, but approval-gated
live system mutation.

Dynamic workflow rules live in:

```text
.pi/openclaw-teams/dynamic-workflows-protocol.md
```

`pi-dynamic-workflows` is installed globally and exposes the `workflow` tool.
The launcher loads it for `pi-orchestrator`, team leads, and specialist
verification/security/testing agents. Treat workflows as short-lived swarms
inside a factory stage: classify-and-act, fan-out-and-synthesize, adversarial
verification, generate-and-filter, tournament, and capped loop-until-done.
Do not use workflows as the persistent Dark Factory runner; WorkOrders,
manifests, PR watching, and evidence ledgers stay deterministic.

Second-latest update rules live in:

```text
.pi/openclaw-teams/update-policy-protocol.md
```

Samuel's maintenance rule is to update Pi, extensions, helper tools, and tool
repos only to the second-latest stable/released version. Do not use latest-only
commands such as `pi update` for unattended maintenance. Product and policy
repos still require the normal fresh-folder, branch, test, PR, and review
workflow.

Claude Code bridge rules live in:

```text
.pi/openclaw-teams/claude-code-bridge-protocol.md
```

Pi agents run through normal Pi model providers for their persistent shell and
tool loop. Ordinary worker shells default to Claude Sonnet 4.5 through the Pi
Anthropic provider. Opus-required roles may use an OpenAI Codex Pi controller
shell, but that shell is not the substantive Opus lane. The self-improvement
team is Codex GPT-5.5 xhigh in `codex-default`; in `claude-default`,
`self-improvement-lead` and `memory-librarian` use Codex GPT-5.5 xhigh Pi
controller shells and Claude Code Opus 4.8 max for substantive work.

When a role needs Samuel's existing Claude Code setup, the launcher loads
`extensions/claude-code-bridge.ts`, which exposes `claude_code_run`. That tool
shells out to the authenticated local `claude` CLI from a specific fresh
repo/work folder and can reuse `/Users/samuelimini/.claude` commands, agents,
hooks, settings, and skills. The launcher also exports
`CLAUDE_CODE_OAUTH_TOKEN` from the macOS Keychain service
`openclaw-claude-code-oauth-token` when it is available.
Bridge calls default to Claude Code `permissionMode=bypassPermissions` under
Samuel's approval, while still keeping the bridge cwd allowlist and product
workflow gates.
Use it for Claude-native PR gates, security swarms, post-PR review loops, and
second opinions after Pi failures. Extensive planning should route to Claude
Code by default. Claude bridge calls default to `claude-opus-4-8` with
`effort=max`; do not override that model or effort unless Samuel explicitly
asks. Per-call model/effort overrides are ignored unless
`OPENCLAW_CLAUDE_BRIDGE_ALLOW_CALL_MODEL_OVERRIDE=1` is set for an explicitly
approved run. Do not use Claude as a generic replacement for Pi/OpenAI workers.

Webwright testing rules live in:

```text
.pi/openclaw-teams/webwright-testing-protocol.md
```

Webwright is installed at `tools/webwright`, with a stable wrapper at
`~/.openclaw/workspace/bin/webwright`. The launcher automatically passes the
Webwright skill to `verification-lead`, `browser-qa-lead`, `test-engineer`,
`browser-tester`, and `visual-qa` when the skill is present. Use it for
long-horizon browser automation, multi-step UI workflows, data extraction,
form-filling, and screenshot-backed reusable scripts.

Each task should have a task id such as `task-20260606-foo`. Agents should put
working notes under:

```text
.pi/openclaw-teams/runs/<task-id>/
```

Role and project memories live under:

```text
.pi/openclaw-teams/memory/roles/
.pi/openclaw-teams/memory/projects/
```

Pi memory is development-only. OpenClaw / Dr Claw owns Samuel's broad memory:
personal context, reminders, assistant behavior, global skills, local machine
setup, and non-development decisions. Pi / Dark Factory owns repo routing, role
lessons, project lessons, run folders, evidence, PR gates, engineering tools,
architecture decisions, and factory operations.

The boundary lives in:

```text
.pi/openclaw-teams/memory-boundary-protocol.md
```

Pi-side GBrain notes should use the non-federated `pi-development` source and
must be captured with `tag: pi-agent-teams`, `domain: development`, and
task/cell/repo fields when task-specific. Do not store personal,
general-assistant, reminder, life, or non-development context in Pi memory.
Route it to OpenClaw memory instead.

## Improvement Loop

Every mission should end with a learning pass:

1. Verification and Browser QA report what failed or passed.
2. Security reports risks and false alarms.
3. Implementation reports fixes made and friction encountered.
4. External calls and adjacent tools are logged, categorized, and summarized.
5. Self-improvement lead distills reusable lessons into role/project memory.
6. Repeated failures or major reusable improvements become Skill Workshop
   proposal requests for OpenClaw.
7. Useful durable lessons are captured to GBrain.

The self-improvement lead should keep lessons factual and small. Memories should
describe what worked, what failed, and what the team should do differently next
time. It should find patterns in both mistakes and efficiency opportunities, but
live skills, protected policy, routing, security gates, external permissions,
and production workflows stay approval-gated.
