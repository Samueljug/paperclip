# Evidence And Gates

Backlinks: [Wiki Home](README.md), [Gate Readiness Matrix](gate-readiness-matrix.md)

## Purpose

Document how Dark Factory decides whether a run is ready, and what evidence is required.

## How It Works

Foreman readiness combines ledger verification, dirty-worktree preflight, required gates, required evidence, loop state, model-review freshness, TestContract freshness, scoped-write enforcement, No Mistakes exact-head binding, Browser QA evidence, mandatory self-improvement/improver review coverage, and Paperclip-visible Option B evidence for Paperclip-backed tickets.

Default evidence by `changeType`:

- `ui`: `test`, `browser_qa`, `screenshot`
- `fullstack`: `test`, `api`, `browser_qa`, `screenshot`, `video`
- `api`: `test`, `api`
- `code`, `test`, `config`: `test`
- `docs`, `process`: `review`

Foreman always adds `improver_review` to the required evidence list. The self-improvement/improver lane is a required `self_improvement` gate for every run before Ship to PR, Done, closed, or final disposition. A PASS must include an accountable owner/reviewer, an improver verdict (`noop`, `lesson_recorded`, `skill_request`, `policy_request`, `monitoring_needed`, or `not_applicable`), non-empty source coverage, missing coverage, and a report artifact. `not_applicable` must name the owner and reason.

Required gates are derived from WorkOrder `gates`, with evidence, self-improvement, and No Mistakes required by default. PR gate is included when `ready --include-pr` is used. When `testExpectation.required=true`, Foreman also requires a frozen TestContract. The visible test suite records the normal `tests` gate, a pre-fix expected-failure run records `oracle_baseline`, and any holdout suite records `oracle_holdout`.

For Paperclip-backed work orders (default: `OPE-*`, or `gates.paperclipEvidence=true`), `evidence-check`, `ready`, `push`, `pr`, and `pr-status --require-eligible` also audit the Paperclip API. The audit is additive and fail-closed: Paperclip comments/attachments can only remove visibility blockers, never replace real Foreman gates. Use `gates.paperclipEvidence=false` only for non-Paperclip smoke/conformance cells. If Paperclip config/API state is missing or ambiguous, Foreman returns a `decisionNeeded` blocker that the coordinator must take visibly to Samuel/OpenClaw and Paperclip.

A **coverage gate** runs alongside these: the `darkfactory.brief-coverage-gate` plugin blocks an issue from advancing when its `brief-artifact-manifest` is incomplete (any media artifact lacks `extracted_text`) or its `coverage-matrix` has an `uncovered` required item or unwaived `off_track` row. The dark-factory PR handoff checklist is also fail-closed on the `coverage-matrix`. See [Brief Coverage Gate](brief-coverage-gate.md).

## Key Files And Commands

- [../foreman.mjs](../foreman.mjs)
- [gate-readiness-matrix.md](gate-readiness-matrix.md)

```bash
node tools/dark-factory/foreman.mjs evidence --run RUN_DIR --kind test --path output.txt --summary "tests passed"
node tools/dark-factory/foreman.mjs run-tests --run RUN_DIR --suite visible --phase pre --expect fail
node tools/dark-factory/foreman.mjs run-tests --run RUN_DIR --suite visible --phase post --expect pass
node tools/dark-factory/foreman.mjs run-tests --run RUN_DIR --suite holdout --phase post --expect pass
node tools/dark-factory/foreman.mjs evidence --run RUN_DIR --kind improver_review --path reports/improver-noop-review.md --summary "improver no-op review"
node tools/dark-factory/foreman.mjs record-gate --run RUN_DIR --gate self_improvement --verdict PASS --summary "improver review complete" --details-json '{"improverVerdict":"noop","owner":"self-improvement-lead","sourceCoverage":["ledger","run artifacts"],"missingCoverage":"none"}' --path reports/improver-noop-review.md
node tools/dark-factory/foreman.mjs evidence-check --run RUN_DIR
node tools/dark-factory/foreman.mjs paperclip-audit --run RUN_DIR --mode ship_to_pr
node tools/dark-factory/foreman.mjs ready --run RUN_DIR --include-pr
```

## Source Files Inspected

- [../foreman.mjs](../foreman.mjs)
- [../schemas/evidence-pack.schema.json](../schemas/evidence-pack.schema.json)
- [../schemas/gate-result.schema.json](../schemas/gate-result.schema.json)
- [../../pi-vs-claude-code/.pi/openclaw-teams/verifier-contract-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/verifier-contract-protocol.md)
- [../../pi-vs-claude-code/.pi/openclaw-teams/stage-gate-relay-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/stage-gate-relay-protocol.md)
- `/Users/samuelimini/Development/dark-factory/05-verification-and-testing.md`
- `/Users/samuelimini/Development/dark-factory/06-quality-gates-and-guardrails.md`

## Invariants And Guardrails

- PASS gates must be for the current evidence, current HEAD, and current diff.
- Test PASS gates must come from `run-tests`; `record-gate --gate tests` is blocked.
- Required TestContracts are frozen before implementation, copied into the run, hashed in the manifest, and checked again at readiness.
- Builders may use visible tests for fast feedback. Holdout suites are verifier-owned and readiness requires `oracle_holdout` when a holdout suite exists.
- Browser QA PASS requires usable `browser_qa` and `screenshot` evidence unless a waiver names owner and reason.
- Self-improvement PASS requires usable `improver_review` evidence, owner/reviewer, non-empty source coverage, missing coverage, and an explicit improver verdict. A no-op is a real PASS only when it is recorded visibly.
- Coverage PASS requires a complete `brief-artifact-manifest` and a `coverage-matrix` with no `uncovered` required item and no unwaived `off_track` row; enforced via the Brief Coverage Gate plugin (host blocker) and the fail-closed PR checklist.
- UI/browser Paperclip-backed tickets require Paperclip-side image/video attachments; local run-folder screenshots/video are supporting evidence, not the only evidence.
- No Mistakes PASS must be for the current git HEAD.
- Model/judge reviews are stale if HEAD or reviewed diff hash changes.
- Evidence is not a replacement for tests; screenshots/video support UI claims, while tests/API evidence support behavior.

## Failure Modes

- A gate can be manually recorded out of order unless the dedicated command blocks it; use dedicated commands for test and shipping gates.
- A visible test can pass while a sealed holdout still fails or was never run; readiness blocks on the holdout gate when it exists.
- A PASS gate with stale HEAD/diff is a blocker, not a warning.
- Missing local file paths for screenshot/video/browser evidence makes Browser QA unusable.
- Missing Paperclip comments/attachments blocks Ship-to-PR/Done eligibility for Paperclip-backed runs.
- Missing self-improvement/no-op evidence blocks Ship-to-PR/Done eligibility even when all technical gates are green.
- A green GitHub PR state is not enough if Foreman PR eligibility is blocked.

## When This Changes, Update

- [Gate Readiness Matrix](gate-readiness-matrix.md) for specific gate logic.
- [Browser QA](browser-qa.md) for browser evidence changes.
- [Worktree, No Mistakes, And PR Shipping](worktree-no-mistakes-pr-shipping.md) for No Mistakes/PR eligibility changes.
- [Conformance And Testing](conformance-testing.md) if new checks need test coverage.
