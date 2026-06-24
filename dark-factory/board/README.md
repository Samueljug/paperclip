# Paperclip Board Pilot

This is the local Paperclip visibility board for OpenClaw and Dark Factory work.
It is a communication/status surface only. It does not replace Pi, the Dark
Factory runner, No Mistakes, GitHub, or Samuel's development policy.

The board now has a local v0 factory run ledger. It is an append-only,
hash-chained JSONL event log under `tools/paperclip-data/factory-run-ledgers/`.
It records observable events, handoffs, decisions, artifacts, approvals,
blockers, and gate results for the improver to review. Do not store secrets or
hidden model chain-of-thought; store decisions, assumptions, rationale
summaries, prompts/results where available, and source artifacts.

## Runtime

- Source checkout: `/Users/samuelimini/.openclaw/workspace/tools/paperclip` (Note: This is a git submodule tracked by `.gitmodules`. On fresh checkouts, initialize and update the submodule via `git submodule update --init --recursive tools/paperclip` to checkout the pinned commit).
- Pinned release: active development commit `ac20100ccbf8a17ce6195ffa26297f7578c36106` (tracking branch `ope-573-guard`)
- Data/config: `/Users/samuelimini/.openclaw/workspace/tools/paperclip-data`
- tmux session: `paperclip-board`
- Local URL: `http://127.0.0.1:3101`
- API health: `http://127.0.0.1:3101/api/health`
- Run ledgers: `/Users/samuelimini/.openclaw/workspace/tools/paperclip-data/factory-run-ledgers`

Start:

```sh
tmux new-session -d -s paperclip-board -c /Users/samuelimini/.openclaw/workspace/tools/paperclip 'pnpm paperclipai run --data-dir /Users/samuelimini/.openclaw/workspace/tools/paperclip-data --bind loopback'
```

Stop:

```sh
tmux kill-session -t paperclip-board
```

## Board

- Company: `OpenClaw Communication Board`
- Company id: `1e8bc12a-f8fd-431c-9fbd-e47be79446a3`
- Issue prefix: `OPE`
- Project: `Dark Factory Visibility Pilot`
- Project id: `c4525f28-55d1-4378-864c-aec26d51fc37`
- Improvement reports project: `Improvement Reports`
- Improvement reports project id: `b999a19a-a5f3-4d41-9d65-f845fd7b7ee0`
- Board owner agent: `OpenClaw Coordinator`
- Board owner agent id: `ec2f4237-5d27-4675-a919-d4cbc45c55ca`
- Self-improvement reporter agent: `Self-Improvement Reporter`
- Self-improvement reporter agent id: `9b8240f0-f0e8-4175-bd06-7534b8f43185`
- The board owner uses a no-op `process` adapter, has heartbeat disabled, and is paused. It exists for assignment/visibility only.
- The self-improvement reporter also uses a no-op `process` adapter, has heartbeat disabled, and is paused. It exists for report ownership/visibility only.

## Pipeline

Use native Paperclip status for coarse visibility:

- `backlog`: intake or needs triage
- `todo`: planned and ready to work
- `in_progress`: active work
- `in_review`: verification, No Mistakes, PR handoff, or human final review
- `blocked`: stuck; comment must name the unblock owner and action
- `done`: final review/sign-off and PR outcome are complete
- `cancelled`: intentionally abandoned

Use labels/comments for the detailed gate:

1. `stage: Planning`
2. `stage: To Do`
3. `stage: In Progress`
4. `stage: Verification`
5. `stage: Browser / Visual QA` when UI, browser, visual, responsive, or user-facing flow validation is involved
6. `stage: Security Review`
7. `stage: No Mistakes Gate`
8. `stage: Ship to PR`
9. `stage: Human Final Review`
10. `stage: Done`

Important: after No Mistakes passes, the next gate is Ship to PR. Once shipped
to PR, the ticket moves to Human Final Review, not Done.

For PR-backed coding tickets, the path is guaranteed and fail-closed:

1. Planning lead intake: difficulty, activation mode, scope, required lanes, and evidence plan.
2. Implementation lead handoff: fresh routed work folder/branch, scoped changes, changed areas recorded.
3. Verification lead gate: acceptance criteria, tests, build/lint/typecheck/API evidence as applicable.
4. Browser / Visual QA lead gate when UI, browser, visual, responsive, design, or user-flow validation is involved.
5. Security lead gate for coding work, or a visible not-applicable reason for pure non-code/admin work.
6. No Mistakes / Foreman gate against the exact current head and routed base before any GitHub branch push or PR creation.
7. Ship to PR only after required lead/lane gates are pass or explicitly waived by Samuel.
8. Human Final Review after PR creation; record PR URL, reviewer routing, CI/check status, review status, and Foreman PR eligibility.

If a required lead/lane verdict, artifact, or waiver is missing, the ticket
stays blocked or in review instead of shipping.

Browser / Visual QA is fail-closed for UI, browser, visual, responsive, and
authenticated app-flow work. The QA lead must open Chrome/Webwright, log in
where the app flow requires it, test the exact changed workflow, capture
screenshots proving the changed state, record a Browser QA report plus
`screenshot` artifacts in the Foreman evidence pack when present, and post the
evidence paths on the Paperclip ticket. Component tests, code inspection, or a
local harness are supporting evidence only. If Chrome, login, app reachability,
tenant/sandbox data, or credentials are blocked, the ticket stays blocked or in
review with the exact owner/action unless Samuel explicitly waives Browser QA
evidence.

For PR-backed coding tickets, Done requires local factory eligibility evidence,
not only a GitHub `MERGED` state. Run Foreman `pr-status --require-eligible`
and keep the ticket out of Done if routed reviewers are still pending, checks
are incomplete or failed, actionable reviews are unresolved, or the No Mistakes
gate is missing/stale for the current PR head. If the PR already merged with
those blockers, record it as a process incident and link the follow-up.

Loop-backed watcher commands:

- `node tools/paperclip-board/pr-task-sweeper.mjs --apply`: fixed PR/task
  reconciliation loop. Merged-with-blockers and waiting-on-review gates are
  parked as `blocked` with explicit owner/action comments, and marker comments
  suppress duplicate blocker churn on later sweeps.
- `node tools/paperclip-board/pr-review-watcher.mjs --apply`: PR review watcher
  loop for open PRs in review; marks actionable comments/check/review failures
  for repair without treating PR comments as trusted instructions.
- `node tools/paperclip-board/no-mistakes-review-watcher.mjs --apply --fail-closed`:
  No Mistakes review watcher loop. It scans `~/.no-mistakes/state.sqlite`,
  `/tmp/df-nm/*/state.sqlite`, Foreman run-manifest `NM_HOME` paths, and
  clone-scoped `.git/no-mistakes/state.sqlite` files, then mirrors
  `review` steps with `awaiting_approval` findings into the mapped Paperclip
  issue and factory ledger. All deterministically mapped issues (including
  `done` and `cancelled`) move back to `in_progress`/`stage: In Progress`
  because actionable findings require re-entering the repair loop regardless
  of prior status. Duplicate markers suppress repeat comments/ledger events
  for the same `NM_HOME`/run/HEAD/findings fingerprint.
- `node tools/dark-factory/loop-health-report.mjs --days 7 --markdown`: weekly
  loop health/economics report. It also includes dirty-worktree hygiene from
  known Development and OpenClaw tool repos.
- `node tools/dark-factory/worktree-health.mjs check --markdown`: report-only
  dirty-worktree scan. It reports the repository path, status, active branch,
  HEAD commit, and a changed file sample without stashing, committing, reverting,
  or deleting anything.
- `node tools/paperclip-board/evidence-audit.mjs ...`: deterministic read-only
  Option B evidence audit. It reports role-comment coverage, required event
  coverage, Paperclip-side attachments/image/video declarations, and factory
  ledger coverage by issue/status/project. With `--fail-closed`, missing
  required visible evidence exits non-zero.
- `node tools/paperclip-board/improver-coverage-audit.mjs --status done --status in_review --require-ledger`: deterministic read-only improver coverage audit/monitor. It reports completed/finalizing factory issues missing visible improver review/no-op/not-applicable coverage, distinguishes `improvement_review`, `improvement_noop`, and `improvement_not_applicable`, links the OPE-248 triggering incident, and supports `--fail-closed` for monitoring/pre-close automation.
- `node tools/paperclip-board/option-b-bridge.mjs ...`: local trusted Option B
  bridge for posting visible role comments and uploading/verifying ticket
  attachments. It never sets `authorAgentId`, never mutates the database, and
  never claims non-forgeable identity.
- `node tools/dark-factory/regression-scenario.mjs add ...`: record a reusable
  regression scenario after real bugs, QA failures, review findings, or
  telemetry issues.
- `node tools/dark-factory/post-merge-telemetry.mjs check ...`: conditionally
  check post-merge telemetry when a source is configured.

Conditional/support lanes:

- Use `research-lead` / architecture planning before implementation for large, ambiguous, multi-repo, or current external-research work.
- Research / Architecture is not the same as Planning. It feeds Planning. The full plan must be visible on the task ticket while the ticket is still in Planning, and Samuel must approve it before the ticket moves to To Do.
- Use `self-improvement-lead` after every team-worked ticket, and earlier for significant runs, repeated failures, review/no-mistakes findings, or reusable process lessons.
- Internal agent research, agent notes, process sidecars, and other coordinator-only items should not wait in Samuel's review queue after their purpose is complete. Summarize the outcome, link any real follow-up, remove Samuel-approval labels, and move them to Done unless Samuel is genuinely the next decision maker.
- Use `security-lead` as a standard visible review gate for coding work in this pilot; for pure non-code/admin tickets, comment why it is not applicable.

## Create A Task

```sh
node <FORK>/dark-factory/board/create-task.mjs \
  --title "Small test task" \
  --brief "Do the smallest useful thing and report evidence."
```

The helper creates the ticket in `todo`, assigns it to the paused
`OpenClaw Coordinator`, and applies `stage: Planning`,
`gate: security-review-required`, and `gate: no-mistakes-required` labels. It
also initializes the task's factory run ledger.

Planning must name the allowed write scope before implementation starts.
Developing, fixing, reviewing, and verifying agents may only edit files/areas
explicitly authorized by the task or approved plan. Anything else they notice
becomes a separate ticket recommendation for Samuel to approve. Security and
self-improvement agents may inspect broadly within their role, but broad
inspection does not authorize remediation or live policy/skill/prompt/product
changes without Samuel or an approved follow-up task.

For tasks that need Research / Architecture before implementation:

```sh
node <FORK>/dark-factory/board/create-task.mjs \
  --title "Architecture-heavy task" \
  --brief "Research the options and propose a plan before implementation." \
  --research-architecture
```

That adds `lane: Research / Architecture` and
`gate: plan-approval-required`. The full plan should be posted on the same
task ticket while it remains in `stage: Planning`; once Samuel approves the
plan, move the ticket to `stage: To Do`.

Add `--dry-run` to print the task payload without creating a ticket.

For tasks with a specific design brief or reference:

```sh
node <FORK>/dark-factory/board/create-task.mjs \
  --title "Design-specific UI task" \
  --brief "Implement the new panel." \
  --design "Panel should match the provided reference: compact table, sticky actions, no card nesting." \
  --design-reference "/path/to/reference.png"
```

That adds `gate: design-verification-required`,
`evidence: design-reference`, and `evidence: screenshots`. Browser / Visual QA
must compare the rendered result against the supplied design source, attach
screenshot/video or visual-diff evidence, and log the finding in the factory run
ledger. If no specific design source is supplied, visual QA should compare
against the product's existing design system and the current design-principles
source where relevant.

## Factory Run Ledger

Every meaningful event in a team-worked task should be appended to the task's
ledger:

```sh
node <FORK>/dark-factory/board/factory-log.mjs \
  event \
  --issue OPE-123 \
  --type stage_changed \
  --actor planning-lead \
  --stage Planning \
  --summary "Planning completed and ready for Samuel approval."
```

Useful event commands:

```sh
node tools/paperclip-board/factory-log.mjs handoff \
  --issue OPE-123 \
  --from planning-lead \
  --to implementation-lead \
  --summary "Plan approved; implement the scoped change." \
  --next-action "Clone fresh repo and start implementation."

node tools/paperclip-board/factory-log.mjs decision \
  --issue OPE-123 \
  --actor architecture-planner \
  --summary "Use the existing API boundary instead of adding a new service." \
  --rationale "The existing boundary covers the workflow and avoids extra deployment risk."

node tools/paperclip-board/factory-log.mjs artifact \
  --issue OPE-123 \
  --actor test-engineer \
  --kind test \
  --path /path/to/test-output.txt \
  --summary "Unit and integration tests passed."
```

Add `--comment` to post a short visible Paperclip comment for the ledger event.

Review/export:

```sh
node tools/paperclip-board/factory-log.mjs verify --issue OPE-123
node tools/paperclip-board/factory-log.mjs coverage --issue OPE-123
node tools/paperclip-board/factory-log.mjs export --issue OPE-123
```

## Evidence Audit Gate

`evidence-audit.mjs` is a deterministic read-only checker for Option B visible
Paperclip evidence. It uses only Paperclip API `GET` routes plus local factory
ledger reads; it does not post comments, upload files, spoof `authorAgentId`, or
mutate the Paperclip database.

Trust warning: a PASS from this tool means required board-visible evidence is
present. It is advisory/forgeable visibility, not non-forgeable identity proof,
not a real Foreman/No-Mistakes/security gate pass, and not sufficient by itself
for Ship-to-PR or Done.

Examples:

```sh
node tools/paperclip-board/evidence-audit.mjs \
  --issue OPE-210 \
  --require-role verification-lead \
  --require-event verification_pass \
  --require-ledger \
  --format text

node tools/paperclip-board/evidence-audit.mjs \
  --status in_review \
  --project-id c4525f28-55d1-4378-864c-aec26d51fc37 \
  --require-event verification_pass \
  --require-event security_pass \
  --require-ledger \
  --fail-closed \
  --format json

node tools/paperclip-board/evidence-audit.mjs \
  --issue OPE-208 \
  --require-event browser_qa_pass \
  --require-image \
  --fail-closed
```

Exit codes:

- `0`: audit ran and required visible evidence is present, or report-only mode
  found missing evidence without `--fail-closed`.
- `1`: `--fail-closed` was requested and required visible evidence is missing.
- `2`: the audit could not run deterministically, such as Paperclip API failure,
  invalid JSON, no selected issues, or ledger read/integrity errors.

Coverage counts are deduped by role/event pair so repeated comments do not
inflate coverage. Attachment checks use Paperclip-side attachment records
(`contentType`/`originalFilename`) and never count local run-folder file paths as
uploaded screenshot/video evidence.

Minimum events to log when applicable:

- brief received / task created
- plan or research/architecture output
- Samuel plan approval
- stage changes
- agent handoffs
- implementation starts/stops and key decisions
- tool outputs and evidence artifacts
- verification findings
- Browser / Visual QA findings
- design/visual verification against the supplied brief/reference
- Security Review findings
- No Mistakes result
- PR creation/URL
- human final review/sign-off
- blockers and unblock actions
- improvement report creation

## Option B Role Comment / Attachment Bridge

`option-b-bridge.mjs` is a local helper for the interim Option B evidence model:
visible/queryable Paperclip comments with advisory role metadata plus verified
Paperclip-side attachments.

Trust warning: Option B attribution is local trusted/display-only. It is not
non-forgeable identity proof and must never decide privileged routing, owner
selection, gate pass decisions, push/PR decisions, or actor identity. The helper
posts comments as `authorType: "user"`; it does not set `authorAgentId`, does
not spoof Paperclip-managed identity fields, does not mutate the database, and
does not modify Paperclip product/runtime code.

Post a role comment:

```sh
node tools/paperclip-board/option-b-bridge.mjs comment \
  --issue OPE-123 \
  --role verification-lead \
  --stage Verification \
  --event-type verification_pass \
  --summary "Verification passed; focused tests are green." \
  --task-id OPE-123-20260611T010000Z \
  --run-folder /absolute/run/folder \
  --source-ref /absolute/run/folder/gates/verification.md
```

Upload and verify an attachment from a safe evidence root:

```sh
node tools/paperclip-board/option-b-bridge.mjs upload \
  --issue OPE-123 \
  --file /absolute/run/folder/evidence/screenshots/contact_sheet.png \
  --evidence-root /absolute/run/folder/evidence \
  --issue-comment-id <optional-comment-id>
```

Useful safety checks:

- `--dry-run` prints the comment payload/upload plan without posting.
- `--agent-name` performs a read-only Paperclip agent lookup and records the
  found agent id/name only in advisory metadata; it still does not set
  `authorAgentId`.
- `--coms-net-target` records the local team target when no registered
  Paperclip agent is available.
- Uploads reject files outside `--evidence-root`, detect MIME type by extension,
  compute byte size and SHA-256, verify the returned attachment appears in
  `GET /api/issues/:id/attachments`, and when `contentPath` is available,
  download it from `PAPERCLIP_ORIGIN + contentPath` for a hash check.

Validation:

```sh
node --check tools/paperclip-board/option-b-bridge.mjs
node --check tools/paperclip-board/option-b-bridge.test.mjs
node tools/paperclip-board/option-b-bridge.test.mjs
node --check tools/paperclip-board/no-mistakes-review-watcher.mjs
node --check tools/paperclip-board/no-mistakes-review-watcher.test.mjs
node tools/paperclip-board/no-mistakes-review-watcher.test.mjs
```

Suggested cron command for the No Mistakes watcher:

```sh
cd /Users/samuelimini/.openclaw/workspace && /opt/homebrew/bin/node tools/paperclip-board/no-mistakes-review-watcher.mjs --apply --fail-closed >> tools/paperclip-data/no-mistakes-review-watcher.log 2>&1
```

## Improvement Reports

Every ticket worked by the team should get a paired report in the
`Improvement Reports` project. The report is a history/proposal artifact: it
reviews the whole factory run, not just the code diff or final output. It
captures the brief, planning/research, conversations, reasoning and handoffs,
work done, evidence, verification, Security Review, Browser / Visual QA, No
Mistakes, CI, PR/human feedback, what worked, what got stuck, and suggested
improvements. It must not mutate Pi, Dark Factory, skills, policy, tools, or
live agent behavior until Samuel approves the follow-up.

Improvement report status is an approval queue:

- `backlog`: proposed improvement parked for Samuel review.
- `todo`: Samuel approved actioning the report; start applying the improvement.
- `in_progress`: approved improvement is actively being implemented.
- `in_review`: applied improvement is waiting on review, PR, or confirmation.
- `done`: approved improvement has been applied or explicitly closed.
- `cancelled`: Samuel rejected or no longer wants the improvement.

New improvement reports default to `backlog`. Samuel moves the report to
`todo` when he wants OpenClaw/Dark Factory to action it. In addition, an
automated **Claude review gate** now triages backlog proposals and can promote a
clearly-useful, safe, non-duplicate proposal to `todo` on Samuel's behalf (see
below); it is fail-closed, so anything ambiguous, unsafe, duplicate, or flagged
`approval: samuel-needed` stays in `backlog` for Samuel.

### Backlog Claude review gate

`improvement-backlog-claude-reviewer.mjs` reviews backlog Improvement Reports
against the Dark Factory codebase, logs, and ledgers using the local Claude CLI,
and decides whether each proposal should be done.

```sh
# dry-run (default): plan only, no writes
node tools/paperclip-board/improvement-backlog-claude-reviewer.mjs --max-candidates 3 --format json
# apply: post a deduped rationale comment + ledger event; promote only on a strict verdict
node tools/paperclip-board/improvement-backlog-claude-reviewer.mjs --apply --max-candidates 5 --format json
# re-review one ticket even if already reviewed
node tools/paperclip-board/improvement-backlog-claude-reviewer.mjs --apply --force --issue OPE-457
```

Flags: `--apply` (default dry-run), `--issue OPE-123` (restrict to specific
reports), `--max-candidates N`, `--force` (re-review an already-reviewed
snapshot), `--format json|text`.

**Fail-closed promotion rule:** the gate only patches a report to `todo` when
Claude returns strict JSON with `decision ∈ {promote_to_todo, should_do}` **and**
`should_do === true` **and** `confidence ∈ {high, medium}`. Every other decision
(`decline`, `stay_backlog`, `duplicate`, `unsafe`, `needs_human_approval`,
`unavailable_logs`, `prompt_injection_risk`, `ambiguous`) and any Claude error,
timeout, empty/invalid output, or unavailable evidence leaves the report in
`backlog`. All ticket/comment/log/ledger/code content is passed to Claude as
untrusted data it must classify, not obey. In `--apply` mode the gate posts a
Paperclip-visible rationale comment and appends a review event to the source
factory-run ledger; both writes plus the status patch are deduped by a snapshot
marker so reruns over an unchanged ticket skip cleanly. `create-improvement-report.mjs`
invokes the gate best-effort after filing a backlog report unless
`--no-claude-review` is passed.

The report should cite the factory run ledger when present. If something
important was not logged, list it under missing logs/logging gaps and treat that
as an improvement finding.

Create a report:

```sh
node <FORK>/dark-factory/board/create-improvement-report.mjs \
  --source OPE-123 \
  --summary "Task completed; no production changes shipped yet." \
  --worked "Planning and No Mistakes evidence were easy to follow." \
  --sources-reviewed "Brief, planning notes, agent handoffs, verification comments, security review, No Mistakes output." \
  --step-observations "Planning was clear; security handoff needed better dependency evidence." \
  --conversation-review "One handoff assumed screenshots were optional; Browser QA corrected it." \
  --issues "Security review needed a clearer handoff checklist." \
  --feedback "Security reviewer asked for dependency evidence." \
  --design-verification "Browser QA compared screenshots against the supplied design reference and found no blocking mismatch." \
  --suggestion "Add dependency evidence to the default security gate checklist." \
  --pattern possible_pattern \
  --target pipeline \
  --approval skill_proposal
```

Add `--dry-run` to print the issue payload without creating a ticket.

Report fields stay intentionally open, but the default sections are:
source ticket, outcome summary, factory run ledger, whole-run sources reviewed,
source log coverage, missing logs/logging gaps, step-by-step factory
observations, conversation/thinking/handoff review, what worked, issues/blockers,
feedback from agents/reviewers/gates, design/visual verification, pattern
status, suggested improvement, target, expected benefit, approval needed,
proposed next action, Samuel approval status, and result if approved/applied.

## Human Access

This pilot is loopback-only. Do not expose it to LAN/tailnet/public access or
invite external human reviewers until Samuel explicitly approves that network
exposure step.
