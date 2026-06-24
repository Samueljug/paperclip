# Dark Factory Protocol

Samuel's Dark Factory goal: he should be able to give OpenClaw one instruction,
and the system should drive the development lifecycle through a production-ready
PR to `stage`, with evidence, review, and learning captured.

## Current Pilot Scope

Start with the legal/dev app:

- `https://github.com/aila-code/frontend-legal`
- `https://github.com/aila-code/backend-legal`
- Local parent: `/Users/samuelimini/Development/Dev`
- Routed PR base / merge target: `stage`

The `devpolicy-legal` policy repo remains on branch `dev` unless Samuel
explicitly changes that.

## Team Activation Gate

OpenClaw / Dark Factory decides the team shape by difficulty, risk, and
required evidence. Samuel should not need to decide whether a task deserves the
full team. When uncertain, choose the higher class and add independent lanes.

Activation modes:

- **Mode 0 - Core-only coordination:** board triage, comments, sweeps, task
  creation, log summaries, or internal-only notes. No product PR should ship
  from this mode.
- **Mode 1 - Core plus specialist lanes:** simple behavior changes. Requires an
  implementation lane, independent verification lane, and focused test/evidence.
- **Mode 2 - Full team or equivalent specialists:** moderate, hard, product,
  PR-repair, frontend/user-flow, or risk-sensitive work. Launch
  `scripts/openclaw-team.sh full` or record equivalent isolated specialist
  lanes on the ticket.
- **Mode 3 - Research / architecture council:** ambiguous direction,
  external-current facts, compliance, strategy, architecture, or plan approval.
- **Mode 4 - Isolated full factory cell:** parallel repo/product streams or any
  work where browser state, No Mistakes home, repo clone, run folder, ledger, or
  evidence could bleed between tasks.

Problem Solvers are a conditional lane inside Mode 2, Mode 3, or Mode 4. Use
them when a difficult implementation/debugging problem needs independent top
model proposals, adversarial discussion, and one recorded approach decision
before implementation resumes.

Difficulty triggers:

- D0 trivial/status/internal note -> Mode 0.
- D1 simple one-file low-risk behavior or docs change -> Mode 1.
- D2 moderate multi-file, UI, non-trivial acceptance criteria, PR repair, or
  previous failed attempt -> Mode 2 or equivalent lanes.
- D3 hard/high-risk frontend+backend, auth, tenancy, PII, documents,
  migrations, billing, secrets, command execution, external integrations,
  dependency/supply-chain risk, failing Claude/CI/No Mistakes/security review,
  or high user impact -> Mode 2 plus targeted verifier, security lane, and
  Problem Solvers when root cause or fix approach is unclear.
- D4 strategic/architecture/parallel -> Mode 3 and/or Mode 4.

Non-negotiables:

- Every product or tooling change must be verified before Done.
- Every Dark Factory run must include a self-improvement/improver review before
  Ship to PR, Done, closed, or any final disposition. Samuel's explicit instruction:
  "Improvers MUST run in every factory run." If no reusable lesson exists,
  `self-improvement-lead` must still post a visible no-op review containing the
  required wording: "Self-Improvement Review (IMPROVER verdict: noop): Existing
  rules and protocols are sufficient for this run. No new lessons were learned, and
  no skill/policy changes are needed." to Paperclip and record ledger/run evidence;
  only no-run/admin cleanup may use an explicit not-applicable reason.
- Every behavior change must have tests, or a ticket-visible reason tests are
  not possible.
- Every frontend, browser, visual, responsive, or user-flow change must use
  Webwright/Playwright/browser evidence with screenshots or video as
  appropriate.
- The implementer must not be the only reviewer for a non-trivial change.
- Missing evidence is a blocker or visible exception, not an implied pass.
- For Paperclip-backed tickets, board-visible evidence uses the Option B
  protocol. Role comments and metadata are advisory/local trusted/display-only,
  not non-forgeable actor identity, and must never be used as authority for
  routing, gate pass decisions, or PR/push choices. They mirror real artifacts;
  they do not replace commands, logs, screenshots/videos, reviews, No Mistakes,
  PR state, or Samuel waivers.
- Any decision, approval, option/scope/identity/security tradeoff, PR/push
  choice, or owner action needed from Samuel must be returned visibly in
  Telegram and on the Paperclip ticket before dependent work continues.

Every non-Mode-0 ticket should record its activation mode, difficulty,
required lanes, and expected evidence before implementation, for example:

```text
Team activation: Mode 2 - Full Team / equivalent lanes
Difficulty: D2 moderate
Required lanes: planning, implementation, verification, browser QA, security,
No Mistakes, self-improvement
Evidence expected: tests, screenshots/video, security review, Foreman gates,
PR status
```

## Guaranteed Ticket Path To PR

All PR-backed coding tickets must pass through the same release path. A ticket
may skip a conditional lane only when the ticket records why that lane is not
applicable. No product PR should be created from an internal-note, board-admin,
or core-only coordination path.

Required path before PR handoff:

1. **Planning lead intake:** classify difficulty, activation mode, allowed write
   scope, affected repos, required lanes, and evidence plan. Research /
   architecture may feed this step, but does not replace it.
2. **Implementation lead handoff:** confirm the implementation lane used a fresh
   routed work folder/branch, stayed inside scope, and recorded changed areas.
3. **Verification lead gate:** verify acceptance criteria, tests, build/lint/
   typecheck/API evidence as applicable, and record a pass/blocker verdict.
4. **Browser QA lead gate:** required for frontend, browser, visual,
   responsive, design, or user-flow work. Record Webwright/Playwright/browser
   screenshots or video, or a ticket-visible not-applicable reason.
5. **Security lead gate:** standard for coding work in this pilot. Record a
   pass/blocker verdict or a ticket-visible not-applicable reason for pure
   non-code/admin work.
6. **No Mistakes / Foreman gate:** run against the exact current head and routed
   base, then write a typed gate result before any GitHub branch push or PR
   creation.
7. **Self-improvement / improver gate:** required for every factory run before
   Ship to PR, Done, closed, or any terminal disposition. Carrying Samuel's instruction:
   "Improvers MUST run in every factory run." Record a run artifact, ledger event, and
   Paperclip-visible improvement review/no-op. If no reusable lesson exists, the visible
   no-op review must use this exact wording: "Self-Improvement Review (IMPROVER verdict: noop):
   Existing rules and protocols are sufficient for this run. No new lessons were learned,
   and no skill/policy changes are needed." A not-applicable result must name an owner and
   reason.
8. **Ship to PR:** create/update the PR only after the required lead/lane gates
   are recorded as pass or explicitly waived by Samuel.
9. **Human Final Review:** after PR creation, record PR URL, reviewer routing,
   CI/check status, review status, and Foreman PR eligibility. Do not move to
   Done until PR outcome and local factory eligibility are complete.

The PR handoff checklist is fail-closed: if a required lead/lane verdict,
artifact, or waiver is missing, the ticket remains blocked or in review instead
of shipping. It is also fail-closed on coverage: if the issue's `coverage-matrix` document
(GET `/api/issues/{issueId}/documents/coverage-matrix`) is missing, or has any
`uncovered` required manifest item or unwaived `off_track` row, the ticket stays
blocked regardless of green lead verdicts. When Paperclip-visible evidence is required, the ticket must also
show the relevant Option B comments and uploaded/listed attachments, while still
checking the underlying evidence directly.

## Dark Factory Wiki Maintenance Gate

Every Dark Factory code, protocol, schema, prompt, runner, or WorkOrder behavior
change must update the wiki at
`<FORK>/dark-factory/engine/wiki/` or record a
ticket-visible no-doc-needed reason.

This gate applies before PR handoff and before Done. Planning should name the
expected wiki impact, implementation should make the wiki edit when needed, and
review/verification should block handoff when both the wiki update and the
no-doc-needed reason are missing.

## Loop Architecture

Dark Factory loops are bounded mechanisms that prompt agents, collect evidence,
judge progress, and stop. They are not open-ended autonomy.

Every loop must have:

- trigger
- owner
- memory source
- judge/oracle
- maximum iterations or schedule boundary
- exit condition
- escalation path
- visible output surface

Foreman is the deterministic state spine for ticket loops. Paperclip is the
visible memory and decision surface. Dynamic workflows are short-lived inner
loop swarms. Cron/watchers are for fixed operational loops. Skill Workshop is
the approval gate for durable process or skill changes.

Delegated Samuel-requested work has an event-first follow-up rule plus a default
30-minute watchdog. If a worker, watcher, monitor, or team reports material
progress, failure, completion, or a blocker, the owning agent acts immediately
and reports to Samuel immediately when the event is material or needs him. If no
trustworthy update arrives, the owner checks source-of-truth state after 30
minutes, then every 30 minutes until the original requested outcome is complete,
cancelled, superseded, or concretely blocked on Samuel. Each watchdog check must
actively move unfinished work forward by unblocking, rerouting, restarting
failed workers, fixing stale handoffs, or escalating the exact Samuel-needed
decision/action.

Fixed operational loops:

- PR/task reconciliation: `paperclip-pr-task-sweeper`, every 30 minutes.
- Improvement approval runner: `paperclip-improvement-todo-watcher`, every 5
  minutes.
- Daily maintenance: `daily-second-latest-tool-updates`, scheduled at 08:30
  Australia/Sydney.
- Loop health/economics: weekly review of loop runs, failures, false positives,
  repeated blockers, and token/time value.

Condition-triggered ticket loops:

- Intake clarification when repo/base/scope/evidence plan is missing.
- Plan adversarial review for D2+ or ambiguous/architecture work.
- Hard Problem Council when root cause is ambiguous, fix loops repeatedly fail,
  verifier/browser/security/No Mistakes gates keep returning actionable
  failures, or leads disagree on the right approach.
- Implementation fix-test when tests, build, lint, typecheck, reproduction, or
  acceptance criteria fail.
- Browser/Webwright user-flow when frontend, browser, visual, responsive,
  authenticated, or user-flow behavior changes.
- Review/security/No Mistakes repair when a reviewer, CI, security, or gate
  finding is actionable.
- PR review watcher after PR creation until checks/reviews/comments are clean.
- Post-merge telemetry for risky merges when a telemetry source is configured.
- Regression scenario memory after real bugs, QA failures, or review findings.
- Factory meta-improvement after team-worked tickets, repeated blockers, and
  failed loops.

Do not run product/competitor opportunity loops until Samuel separately
approves that source-monitoring lane.

Guards:

- No unbounded loops.
- No model-only Done verdict for product/tooling work.
- No live policy/skill/tool mutation from a loop without Samuel approval or an
  approved task path.
- A loop that exhausts creates a blocker and an improvement finding; it does
  not silently retry forever.

## Parallel Project Isolation

Before running multiple Dark Factory streams at once, load:

```text
.pi/openclaw-teams/parallel-project-isolation-protocol.md
```

Each stream must be a separate factory cell with its own namespace, work folder,
repo clones, branch/base, run folder, manifest, ledger, evidence, No Mistakes
home, and source/research artifacts. Do not rely on prompt discipline to prevent
Stage, Website, and Dev bleed. If a tool cannot be scoped to the current cell,
stop that cell and report the blocker.

## Memory Boundary

Before writing durable memory, load:

```text
.pi/openclaw-teams/memory-boundary-protocol.md
```

Dark Factory memory is development-only. Use it for repo work, architecture,
evidence, PRs, verification, security, testing, tooling, and factory operations.
Do not store Samuel's personal/general assistant context, reminders, life notes,
or non-development facts in Pi memory. Route those to OpenClaw / Dr Claw memory.

## Design Principles

The website repo is the source of truth for design principles:

- Repo: `https://github.com/aila-code/aila-website`
- Branch: `stage`
- Current file: `DESIGN.md`

For frontend, UI, marketing, or visual work, agents should consult the website
design file before judging design quality. If the rule needs to improve, propose
a focused website repo PR to update the design docs rather than scattering the
principle only in chat or local memory.

## Copy And Content Lane

Before static marketing, website copy, blog, sales enablement, CTA, offer, or
conversion-copy work reaches implementation, load:

```text
.pi/openclaw-teams/copy-content-lane-protocol.md
```

Route website copy through the local Claude CLI copy skill when available
(`/quillio-website-copywriter` for website/page copy,
`/quillio-blog-copywriter` for blog/content, and
`/quillio-sales-orchestrator` for offer/funnel copy). Record the copy brief,
claims made, proof for each claim, unsupported/risky claims, positioning
assumptions, and human-review needs before PR.

## Evidence Policy

Choose evidence based on the kind of change.

## Strict Task-Scope Boundary

Developing, fixing, reviewing, and verifying agents must only touch what the
accepted task explicitly authorizes. Nearby bugs, cleanup, refactors, copy
improvements, architecture ideas, or unrelated review findings become separate
tickets for Samuel to approve. They do not get fixed opportunistically inside
the current task.

Security and self-improvement agents may inspect broadly and report broader
risks or process improvements, but they remain read-only/proposal-oriented
unless Samuel or an approved task explicitly authorizes remediation.

## Research And Architecture

Before implementation, route large ideas, ambiguous product direction,
multi-repo work, external-current-facts work, and major architecture through:

```text
.pi/openclaw-teams/research-architecture-protocol.md
```

The research lane should create a source-backed dossier before planning. The
architecture lane should then run an adversarial council using Claude Code,
Codex 5.5 extra-high, and a skeptic/verifier, and should apply the five-step
algorithm before accepting the design: question requirements, delete, simplify,
accelerate cycle time, then automate.

## Hard Problem Council

Before implementation keeps iterating on a hard or stuck problem, route through:

```text
.pi/openclaw-teams/hard-problem-council-protocol.md
```

The Problem Solvers group is for difficult implementation/debugging decisions,
not broad product architecture. Each solver first proposes independently, then
the group challenges assumptions and records one `hard-problem-decision.md`
artifact. `implementation-lead` resumes from that decision only after the
selected approach, dissent, verification requirements, and stop conditions are
visible in the task run folder.

### Screenshots Are Required For

- Simple design or visual element changes.
- Mobile/responsive layout checks.
- UI states where screenshots show the relevant behavior clearly.
- Static page or marketing content changes.

Capture enough screenshots to cover the relevant viewport/state set, usually
desktop and mobile at minimum.

### Video Is Required For

- Functional user flows.
- Work that touches frontend and backend/API behavior together.
- Business-logic flows where the sequence matters.
- Multi-step UI workflows such as login, form submission, filtering, document
  generation, checkout, or error recovery.

Video should show the complete flow and be paired with test/API evidence where
backend behavior matters.

### Tests Are Still Required

Screenshots and videos are evidence, not replacements for tests. Functional
changes still need appropriate lint, typecheck, unit/integration/API tests,
browser checks, build checks, and pre-PR/no-mistakes gates. No Mistakes is the
required pre-GitHub push gate, but it is only a mechanical block when the work
is routed through a wired hook or the Dark Factory Foreman. For factory runs,
Foreman must own No Mistakes execution and any push/PR command, and it must
write a typed gate result for the exact head/base before any branch push or PR
creation.

### Foreman Run Discipline

For factory runs, use Foreman for the mechanical lifecycle rather than relying
on chat summaries:

- Run `foreman advance` with an absolute run path at each real stage handoff.
- Record pre-fix bug reproduction with `foreman reproduction` when the task is a
  bug fix or regression.
- Record tests, browser/visual QA, security, No Mistakes, model review, judge
  review, push, PR creation, and PR status as typed Foreman gates or evidence.
- After PR creation, run `foreman pr-status` so CI/check/review state is saved
  in the run ledger.
- Use `foreman left-aside` for useful out-of-scope reviewer notes instead of
  expanding the current task without Samuel's approval.
- Treat a passing model or judge review as stale after any subsequent code diff
  unless the review is rerun or the reviewer explicitly accepts the changed
  diff.

## Cross-Review

The agent that implemented a change must not be the only reviewer of that
change.

Default cross-review:

- Implementation agent builds or fixes.
- Verification agent checks tests and acceptance criteria.
- For high-risk or complex work, verification runs a targeted verifier-contract
  pass: decompose claims, prove or disprove each one, record unverified gaps,
  and send corrective feedback before no-mistakes/pre-PR.
- Browser/visual QA checks screenshots or video evidence when UI is involved.
- Security agent reviews auth, data, permissions, secrets, command execution,
  and dependency risk when relevant.
- Self-improvement lead captures reusable lessons.

When agents disagree, prefer evidence over confidence. Escalate unresolved
material disagreements to OpenClaw.

## Stage Gate

Product work should target and merge into `stage` after the gates pass. Do not
merge with:

- failing checks
- requested changes
- unresolved actionable comments
- missing required screenshots/video/test evidence
- unclear merge method or branch state

If a gate cannot be satisfied safely, stop and ask Samuel.
