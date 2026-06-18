# Dark Factory Foreman

This is the deterministic runner layer for the Dark Factory pilot.

Full operator and implementation documentation lives in
[`wiki/README.md`](wiki/README.md). Start there for the architecture, operating
model, Foreman command reference, artifacts, gates, Paperclip integration,
Pi/OpenClaw protocols, runbooks, source map, and change-maintenance contract.
The wiki also documents the separate scheduled intake/handoff foreman in
`<FORK>/dark-factory/intake`, which
claims Paperclip Todo cards and hands them to `pi-orchestrator`.

Paperclip remains the visible board and conversation history. Foreman owns the
mechanical run state:

- validates a `WorkOrder`
- requires an explicit `TaskRouteContract` that binds the task to the intended
  repo, branch, and route kind before work starts
- requires a pre-frozen `AcceptanceContract`
- freezes an optional required `TestContract` before implementation starts
- creates a `RunManifest`
- records typed `GateResult` files
- records and checks an `EvidencePack`
- writes to the Paperclip factory ledger
- owns No Mistakes / push / PR commands for factory runs when agents route
  shipping through Foreman

The first version is deliberately narrow. It is not a complete factory yet:
schema validation is a focused v0 validator, browser/session isolation is not
fully proven, and push/PR enforcement depends on using Foreman as the shipping
path. It should prove one small legal/dev ticket before dashboards, more
personas, auto-merge, or multi-project autonomy.

## Commands

```bash
node tools/dark-factory/foreman.mjs validate --workorder path/to/workorder.json
node tools/dark-factory/foreman.mjs start --workorder path/to/workorder.json
node tools/dark-factory/foreman.mjs status --run RUN_DIR
node tools/dark-factory/foreman.mjs advance --run RUN_DIR --stage "Verification" --summary "..."
node tools/dark-factory/foreman.mjs evidence --run RUN_DIR --kind test --path output.txt --summary "tests passed"
node tools/dark-factory/foreman.mjs reproduction --run RUN_DIR --path bug.txt --summary "pre-fix bug reproduced"
node tools/dark-factory/foreman.mjs evidence-check --run RUN_DIR
node tools/dark-factory/foreman.mjs run-tests --run RUN_DIR --suite visible --phase pre --expect fail
node tools/dark-factory/foreman.mjs run-tests --run RUN_DIR --suite visible --phase post --expect pass
node tools/dark-factory/foreman.mjs run-tests --run RUN_DIR --suite holdout --phase post --expect pass
node tools/dark-factory/foreman.mjs review-gate --run RUN_DIR --type model_review --reviewer codex --verdict PASS --summary "review passed" --path review.md
node tools/dark-factory/foreman.mjs claude-judge --run RUN_DIR --verdict-file verdict.json
node tools/dark-factory/foreman.mjs evidence --run RUN_DIR --kind improver_review --path reports/improver-noop-review.md --summary "improver no-op review"
node tools/dark-factory/foreman.mjs record-gate --run RUN_DIR --gate self_improvement --verdict PASS --summary "improver review complete" --details-json '{"improverVerdict":"noop","owner":"self-improvement-lead","sourceCoverage":["ledger","run artifacts"],"missingCoverage":"none"}' --path reports/improver-noop-review.md
node tools/dark-factory/foreman.mjs left-aside --run RUN_DIR --summary "future candidate" --details "..."
node tools/dark-factory/foreman.mjs worktree-check --run RUN_DIR
node tools/dark-factory/foreman.mjs no-mistakes --run RUN_DIR
node tools/dark-factory/foreman.mjs ready --run RUN_DIR
node tools/dark-factory/foreman.mjs push --run RUN_DIR --remote origin --branch branch-name
node tools/dark-factory/foreman.mjs pr --run RUN_DIR --title "..." --body "..."
node tools/dark-factory/foreman.mjs pr-status --run RUN_DIR
node tools/dark-factory/foreman.mjs pr-status --run RUN_DIR --require-eligible
node tools/dark-factory/foreman.mjs loop-summary --run RUN_DIR
node tools/dark-factory/foreman.mjs iterate --run RUN_DIR --loop implementation-fix-test --verdict FAIL --summary "..."
node tools/dark-factory/regression-scenario.mjs add --issue OPE-123 --kind webwright --summary "..." --trigger "..." --reproduction "..." --verification "..."
node tools/dark-factory/post-merge-telemetry.mjs check --pr-url https://github.com/org/repo/pull/1 --error-log errors.log
node tools/dark-factory/worktree-health.mjs check --markdown --fail-on-dirty
node tools/dark-factory/loop-health-report.mjs --days 7 --markdown
node tools/dark-factory/loop-health-report.mjs --days 7 --stale-hours 12 --mark-stale-blocked
node tools/dark-factory/prompt-lint.mjs
```

## Examples

- `examples/minimal-workorder.json` is only for Foreman smoke tests. It is not
  safe to copy for a coding ticket because it deliberately disables code gates.
- `examples/development-code-workorder.json` is the starting shape for small
  legal/dev coding tickets. Copy it and update the issue, clone path, branch,
  allowed write scope, and acceptance criteria.
- Every WorkOrder must include `taskRoute`. Main app stage work must route to
  `https://github.com/aila-quillio/quillio-backend` or
  `https://github.com/aila-quillio/quillio-frontend` on `stage`. Stage work on
  `github.com/aila-code/*` must be explicitly marked `legal_dev_app`.
- `account-context-gateway.mjs` is the safe OPE-179/OPE-413 account-context
  router slice. It supports deterministic registry/policy decisions, static
  `CLAUDE_CONFIG_DIR` mapping, redacted audit evidence, and a CLIProxyAPI
  single-account sidecar boundary. See
  `wiki/compliant-account-context-routing.md`.

## Improvement-Report Rules

- Run `advance` for every real stage handoff so the manifest, ledger, and board
  history do not drift from the live pipeline.
- WorkOrders must include a matching `taskRoute`. `ambiguous_stage` is a
  validation failure, wrong-org stage routing fails closed, and route repo URL,
  base branch, optional work branch, and optional local path must match the
  WorkOrder's repo fields.
- Code, API, and fullstack WorkOrders must explicitly enable tests, security
  review, No Mistakes, evidence, and PR gates. UI and fullstack WorkOrders must
  explicitly enable Browser QA.
- Use `reproduction` for pre-fix bug evidence before the implementation changes
  behavior. It records a typed `pre_fix_reproduction` evidence item.
- Required test work should include a frozen `testContract` on the WorkOrder
  before implementation starts. Foreman copies it to `test-contract.json`,
  stores its hash in the run manifest, and blocks implementation/readiness if
  the contract is missing, mutable, or changed.
- Use `run-tests` for test gates. It records the command, cwd, exit code, HEAD,
  diff hash, and TestContract hash, then writes `tests`, `oracle_baseline`, or
  `oracle_holdout`. `record-gate --gate tests` is intentionally blocked.
- The builder-facing path is the `visible` suite. The verifier-owned
  `holdout` suite remains sealed by process and is required as
  `oracle_holdout` when present in the TestContract.
- Use `review-gate`, `model-review`, or `judge-review` for external/model
  review passes. The gate records reviewer, model, reviewed HEAD, diff base,
  diff hash, and optional evidence path.
- A passing model or judge review becomes stale if HEAD or the reviewed diff
  changes. `ready` and `status` report this instead of treating an old review as
  still valid.
- Use `left-aside` for useful reviewer notes that are outside the accepted task
  scope. Those notes stay with the run without expanding the current ticket.
- After PR creation, run `pr-status` to capture check, review, merge-state, and
  review-request evidence for the run ledger.
- Every Dark Factory run must record an improver review before Ship to PR, Done,
  closed, or final disposition. If no reusable lesson exists, record a visible
  no-op with `improver_review` evidence, a `self_improvement` PASS gate, ledger
  event, and Paperclip comment for Paperclip-backed work. `not_applicable` must
  name the owner and reason.
- Before marking a PR-backed ticket ready to merge or done, run
  `pr-status --require-eligible`. It blocks when routed reviewers are still
  requested, checks are failing or pending, a change-request review is active,
  or the typed No Mistakes gate is missing/stale for the current PR head.
- `no-mistakes` detects old/new CLI syntax, uses a short task-scoped
  `NM_HOME`, disables known auto-merge toggles, and reruns when No Mistakes
  changes HEAD so the typed gate binds to the stabilized final commit.
- `claude-judge --verdict-file path/to/verdict.json` writes a compact verdict
  artifact alongside the full Claude output for CI workflows that need a stable
  file to read after review.
- Foreman `ready`, `no-mistakes`, `push`, and `pr` perform a live dirty
  worktree preflight for the run repo. Dirty or unscannable worktrees block
  shipping gates until the owner commits, deliberately parks, or moves the work
  into visible task scope. The check is report-only; it never stashes, commits,
  reverts, or deletes files.
- A GitHub PR that is already merged can still be a Dark Factory incident. If
  `mergeEligibility.mergedWithBlockers` is true, record the blocker evidence,
  create or update the process-fix ticket, and do not use the merge alone as
  proof that the factory gates passed.
- Evidence, gate, stage, PR-status, and loop mutations are serialized with a
  per-run lock and atomic JSON writes. The conformance script intentionally runs
  parallel evidence and gate writes to prove updates are not dropped.
- WorkOrders can define a primary `loop` plus conditional `loops[]`. Each loop
  should name its trigger, owner, judge/oracle, memory, max iterations, exit
  condition, and escalation path. `iterate --loop <id>` records loop progress
  against that specific loop and blocks readiness when the loop exhausts.
- Implementation WorkOrders must include exactly one `plan_adversarial_review`
  loop. When the planning team returns a plan, the orchestra, Foreman, and
  Claude workers must push back exactly once before implementation proceeds and
  ask: "Is there anything else that has been missed? Are there any errors? Are
  there any conflicts in the plan?" Record the planning team's response or lack
  of response in the ticket, Foreman loop event, run evidence, or other source
  of truth. Foreman blocks `In Progress` and readiness until this one-shot loop
  is recorded as PASS.
- UI, browser, visual, responsive, and authenticated app-flow work requires a
  Browser QA PASS backed by a usable `browser_qa` report and `screenshot`
  artifact in the evidence pack. `ready`, `push`, and `pr` fail closed when the
  Browser QA gate is missing, PARTIAL/BLOCKED/FAIL, or lacks screenshot-backed
  evidence. Use an explicit Samuel waiver only when he has actually waived the
  browser evidence.
- Do not use `record-gate` to fake shipping gates. `push` and `pr` must run
  through `foreman push` and `foreman pr` so readiness, Browser QA, No Mistakes,
  self-improvement, and evidence preflights cannot be bypassed.
- Regression scenarios are stored in
  `tools/paperclip-data/regression-scenarios/scenarios.jsonl`; use them to turn
  real bugs, QA failures, review findings, and telemetry issues into reusable
  tests or Webwright flows.
- Post-merge telemetry is source-adapter driven. Without a configured telemetry
  log/source it exits with `status=not_configured`; that is a visible setup gap,
  not a hidden pass.
- Loop health reports summarize exhausted loops, repeated blockers, gate
  failures, dirty worktrees, and loop iteration coverage. Use them to decide
  whether a loop is economically useful, too noisy, or needs a process
  improvement.
- Run `prompt-lint.mjs` when adding or changing Pi team prompts. Any prompt that
  can implement, review, verify, QA, secure, release, orchestrate, or improve
  work must load `shared-protocol.md` or include the strict task-scope boundary.
