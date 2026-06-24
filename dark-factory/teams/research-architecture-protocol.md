# Research And Architecture Protocol

Use this protocol when Samuel gives a large idea, ambiguous product direction,
multi-repo feature, architectural change, integration strategy, market/technical
research task, or any plan where the cost of building the wrong thing is high.

The goal is to turn a big idea into a research-backed architecture decision, not
to let one confident agent invent a plan from vibes.

## Trigger

Run this lane before normal implementation planning when any of these are true:

- The idea spans multiple repos, products, environments, tools, or teams.
- External facts, current docs, API behavior, competitor behavior, X/Grok
  discussion, or current model/tool capability could change the answer.
- Samuel asks for "research", "architecture", "large design", "big idea",
  "question everything", "adversarial brains", or similar.
- The implementation would be expensive to unwind after coding starts.

Simple bug fixes, deterministic repo inspection, and small UI changes should not
pay this research cost unless Samuel asks.

## Roles

- `pi-orchestrator` decides whether the research lane is required and creates a
  distinct task id/run folder.
- `research-lead` owns source discovery, source fan-out, source notes, and the
  research dossier. It does not implement code. For non-trivial research, it
  should orchestrate a small research council rather than acting as a solo
  researcher. For strategic or architecture-shaping research, each research
  role should get a Claude Code Opus 4.8 max counterpart/pass via
  `claude_code_run` when Claude is available.
- `planning-lead` preserves Samuel's brief and waits for the research dossier
  before producing the implementation plan.
- `architecture-planner` owns the architecture council and final technical
  decision record. For large designs it must run a full Claude Code Opus 4.8
  max architecture review via `claude_code_run` before finalizing, then use
  Codex 5.5 extra-high as an independent cross-check rather than the only
  architecture brain.
- `verification-lead` later checks whether the accepted plan and implementation
  stayed inside the research-backed decision.
- `self-improvement-lead` captures reusable research misses, bad sources,
  expensive dead ends, or architecture-review improvements.

## Research Council

The research team should have multiple distinct research personalities. They
should talk to each other, challenge each other's assumptions, and bring a
synthesized result back to `research-lead`. The goal is not more noise; it is
minimum input for maximum useful signal.

For large, ambiguous, strategic, or expensive-to-reverse work, `research-lead`
should run at least these council roles through available agents, dynamic
workflows, Claude Code, Codex, Gemini, or bounded local prompts. When Claude
Code is available, every role below should either be performed directly by a
Claude Code Opus 4.8 max pass or have a Claude Code Opus 4.8 max counterpart
whose result is considered before synthesis:

- `source-cartographer`: maps the source universe, finds primary docs, current
  vendor constraints, competitor examples, and what should be ignored.
- `customer-revenue-researcher`: asks what creates the most revenue, shortest
  path to value, easiest user journey, and best client outcome.
- `technical-prober`: checks APIs, repos, integration boundaries, data models,
  operational constraints, and what can be cloned as a narrow pattern.
- `risk-compliance-researcher`: looks for legal, privacy, security,
  contactability, vendor-retention, and prompt-injection blockers.
- `skeptic-red-team`: argues that the plan is overbuilt, copied from the wrong
  source, unsafe, too slow, or solving the wrong problem.
- `synthesis-editor`: compresses the council output into decisions,
  contradictions, rejected options, open blockers, and recommended architecture
  questions for `architecture-planner`.

Council rules:

- Each role must have a clear personality and job. Do not ask five agents the
  same generic question.
- Roles must see the same original brief and Samuel's priorities: simplest
  powerful stack, easiest user journey, strongest revenue/client outcome, and
  fastest scaling path.
- Roles should explicitly respond to at least one other role's strongest point
  or weakness before final synthesis when the tool path supports it.
- For strategic research, do not accept a Codex-only research council when the
  Claude bridge is available. If Claude Code is unavailable, record the degraded
  path and why.
- `research-lead` must critique the council output before accepting it. Loud,
  recent, or confident sources are not enough.
- The final dossier should separate verified facts, source opinions, model
  opinions, contradictions, rejected sources, missing evidence, and open
  questions.

## Source Fan-Out

The research lead should run independent source adapters where available, then
normalize the results. Do not force a source if it is unavailable or would
expose private data. Record unavailable adapters explicitly.

Preferred adapters:

- `firecrawl`: crawl and extract web/docs pages when a Firecrawl CLI/API/tool is
  configured. Fall back to local web fetch/search or `curl` when unavailable.
- `google_search`: use OpenClaw/web search or a configured Google search path
  for current web and docs discovery.
- `x_grok`: use Grok/X search when available. If Grok is unavailable, use
  `xurl search` for X.com discussion and label it as X-only, not Grok.
- `gemini_cli`: use `gemini -p` for Google/Gemini second opinion, summarization,
  or long-context synthesis when it is installed and authenticated.
- `claude_code`: use `claude_code_run` for Claude Code deep research,
  architecture critique, or Claude-native agents/skills from a bounded cwd.
- `codex_55_xhigh`: use Pi/OpenAI Codex `openai-codex/gpt-5.5:xhigh` for the
  OpenAI-side research or architecture pass.
- `api_probe`: call official APIs or docs endpoints directly when the task
  depends on exact API shape, pricing, status, or behavior.
- `repo_probe`: inspect the target repo(s), existing architecture, local docs,
  configs, tests, and design/policy files before recommending architecture.

Each adapter result should record:

```text
adapter:
query_or_prompt:
source_urls_or_paths:
retrieved_at:
status: complete | partial | unavailable | failed
confidence: high | medium | low
claims:
contradictions:
quotes_or_evidence:
risk_notes:
```

## Required Artifacts

Save the durable state under:

```text
.pi/openclaw-teams/runs/<task-id>/
```

For large designs, create at least:

- `research-dossier.md`: brief, source matrix, verified claims,
  disagreements, gaps, and source-quality notes.
- `architecture-council.md`: Claude/Codex/other architect proposals,
  adversarial critiques, rejected options, and synthesis.
- `architecture-decision.md`: accepted architecture, non-goals, decisions,
  open questions, implementation sequence, gates, and stop conditions.
- `raw-council/`: raw or tightly bounded council outputs, adapter results,
  reviewer notes, and prompts that materially shaped the synthesis.

Prefer short cited summaries over raw transcripts. Keep raw external output out
of the dossier unless the text is needed and safe to store. When raw output is
too large, private, or unsafe to persist, save a redacted or bounded summary in
`raw-council/` and name what was omitted. Do not mark a plan approval-ready
until the raw/summary council evidence exists alongside the synthesis.

## Architecture Council

The architecture council should not be a rubber stamp.

Minimum council for large work:

- Claude Code Opus 4.8 max architect: primary pragmatic architecture review,
  risks, hidden assumptions, and what should be deleted or simplified.
- Codex 5.5 extra-high architect: independent architecture proposal, migration
  strategy, integration risks, and testability.
- Skeptic/verifier: argues against both proposals, identifies missing evidence,
  overbuild, security risk, and repo/process bleed.
- Synthesizer: chooses a final architecture or hybrid, with explicit reasons.

Council rules:

- Do not ask agents to agree. Ask them to find what the others missed.
- Keep the original brief visible in every prompt.
- The architecture-planner must save or summarize the Claude Opus 4.8 max
  review in the run folder before the final architecture decision.
- Resolve disagreements with evidence, codebase constraints, policy, tests,
  operational cost, and Samuel's priorities.
- Mark any unresolved material question as a blocker or explicit assumption.
- Architecture may recommend "do not build this yet" when research or the
  algorithm shows the requirement is weak.

## Critical Review Checkpoint

After a major architecture plan and before implementation planning, run a
separate critical-review checkpoint. Use it for phone/compliance/conversion-heavy
work, multi-repo plans, customer-action systems, security-sensitive work, or any
plan where a bad assumption would be expensive to unwind.

The checkpoint must:

- read the original brief, research dossier, architecture council, raw council
  evidence, and architecture decision
- challenge missing proof, overbuild, unsafe automation, compliance gaps,
  hidden integration cost, and weak conversion/customer journey assumptions
- name concrete changes needed before implementation or explicitly say no
  material blocker was found
- save the result as `critical-review.md` or append a clearly labelled section
  to `architecture-decision.md`

Implementation planning must not proceed on a large plan until this checkpoint
is saved or a degraded/skip reason is recorded.

## Musk Algorithm Pass

Before the final architecture is accepted, apply the five steps in order:

1. Question every requirement. Make each requirement less dumb. Name the human
   owner or source of the requirement, and challenge inherited assumptions.
2. Delete. Remove features, processes, integrations, agents, files, gates, and
   abstractions that are not necessary. If nothing is deleted, the pass is too
   timid.
3. Simplify and optimize what remains. Do not optimize something that should
   have been deleted.
4. Accelerate cycle time. Prefer architecture that improves iteration speed,
   local reproduction, review latency, and recovery from mistakes.
5. Automate only after the previous steps. Automation should encode a validated,
   simplified process, not lock in bloat.

Record the result as:

```text
questioned_requirements:
deleted:
simplified:
cycle_time_improvements:
automation_candidates:
deferred_or_rejected_automation:
```

## Isolation And Bleed Control

Research and architecture can run across several projects at once only when
each work stream has its own task id, run folder, repo clones, branch/base,
source matrix, architecture decision, and evidence ledger.

Never mix:

- source notes from different task ids unless the later task explicitly cites
  the earlier task as context
- repo paths, branches, PR numbers, or run folders
- website design policy with app behavior unless the design file is deliberately
  being used as the design source
- development, staging, and website implementation plans in one unlabelled
  dossier

If a source or architect response talks about the wrong product/repo/env, mark
that result contaminated and do not use it as evidence.

## External Learning

Every meaningful adapter call that influences the plan should be logged under
`.pi/openclaw-teams/external-learning-protocol.md`.

Use categories:

- `research`
- `source_fanout`
- `architecture_council`
- `firecrawl`
- `google_search`
- `x_grok`
- `gemini_cli`
- `claude_code`
- `codex_55_xhigh`
- `api_probe`
- `repo_probe`
- `musk_algorithm`

If the research lane changes the outcome, saves implementation time, finds a bad
assumption, or misses something important, send a learning note to
`self-improvement-lead`.
