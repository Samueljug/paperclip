# Foreman Command Reference

Backlinks: [Foreman CLI](foreman-cli.md), [Runbooks](runbooks.md)

## Purpose

Provide a stable operator-facing command reference for the live Foreman CLI.

## How It Works

Commands are grouped by the state they mutate or inspect. Commands that mutate run state write atomic JSON files and append ledger events. Evidence and gate writes are serialized by a per-run lock.

## Key Files And Commands

Run lifecycle:

```bash
node tools/dark-factory/foreman.mjs validate --workorder path/to/workorder.json
node tools/dark-factory/foreman.mjs start --workorder path/to/workorder.json
node tools/dark-factory/foreman.mjs start-from-paperclip --issue-json path/to/issue.json --workorder-out path/to/workorder.json [--start true]
node tools/dark-factory/foreman.mjs handoff-watchdog --issue-json path/to/issue.json [--runs-dir DIR] [--max-age-minutes 15] [--apply true]
node tools/dark-factory/foreman.mjs quarantine --run RUN_DIR [--max-active-minutes 1440] [--apply true] [--clear true]
node tools/dark-factory/foreman.mjs status --run RUN_DIR
node tools/dark-factory/foreman.mjs advance --run RUN_DIR --stage "Verification" --summary "..."
```

Evidence:

```bash
node tools/dark-factory/foreman.mjs evidence --run RUN_DIR --kind test --path output.txt --summary "..."
node tools/dark-factory/foreman.mjs reproduction --run RUN_DIR --path bug.txt --summary "pre-fix bug reproduced"
node tools/dark-factory/foreman.mjs evidence --run RUN_DIR --kind improver_review --path reports/improver-noop-review.md --summary "improver no-op review"
node tools/dark-factory/foreman.mjs evidence-check --run RUN_DIR
node tools/dark-factory/foreman.mjs paperclip-audit --run RUN_DIR --mode ship_to_pr
node tools/dark-factory/foreman.mjs run-tests --run RUN_DIR --suite visible --phase pre --expect fail
node tools/dark-factory/foreman.mjs run-tests --run RUN_DIR --suite visible --phase post --expect pass
node tools/dark-factory/foreman.mjs left-aside --run RUN_DIR --summary "future candidate" --details "..."
```

Gates:

```bash
node tools/dark-factory/foreman.mjs stage-token --run RUN_DIR --token PLAN --verdict PASS --summary "..."
node tools/dark-factory/foreman.mjs browser-qa --run RUN_DIR --report report.md --screenshot shot.png --summary "..." [--video flow.mp4] [--smoke true]
node tools/dark-factory/foreman.mjs run-tests --run RUN_DIR --suite holdout --phase post --expect pass
node tools/dark-factory/foreman.mjs review-gate --run RUN_DIR --type model_review --reviewer codex --verdict PASS --summary "..."
node tools/dark-factory/foreman.mjs claude-judge --run RUN_DIR --verdict-file verdict.json
node tools/dark-factory/foreman.mjs record-gate --run RUN_DIR --gate self_improvement --verdict PASS --summary "improver review complete" --details-json '{"improverVerdict":"noop","owner":"self-improvement-lead","sourceCoverage":["ledger","run artifacts"],"missingCoverage":"none"}' --path reports/improver-noop-review.md
node tools/dark-factory/foreman.mjs no-mistakes --run RUN_DIR
node tools/dark-factory/foreman.mjs ready --run RUN_DIR
```

Shipping:

```bash
node tools/dark-factory/foreman.mjs push --run RUN_DIR --remote origin --branch branch-name
node tools/dark-factory/foreman.mjs pr --run RUN_DIR --title "..." --body "..."
node tools/dark-factory/foreman.mjs pr-status --run RUN_DIR --require-eligible
```

Loops:

```bash
node tools/dark-factory/foreman.mjs loop-summary --run RUN_DIR
node tools/dark-factory/foreman.mjs iterate --run RUN_DIR --loop implementation-fix-test --verdict FAIL --summary "..."
```

## Source Files Inspected

- [../foreman.mjs](../foreman.mjs)
- [../README.md](../README.md)
- [../examples/development-code-workorder.json](../examples/development-code-workorder.json)

## Invariants And Guardrails

- Use absolute run paths where possible.
- Use `foreman no-mistakes`, `foreman push`, and `foreman pr` for shipping gates; do not fake them with `record-gate`.
- Use `foreman run-tests` for test gates; `record-gate --gate tests` is blocked so PASS must be bound to a command, HEAD, diff hash, and TestContract hash when present.
- Use `foreman browser-qa` for browser QA/smoke evidence and gates; `record-gate --gate browser_qa` is blocked.
- Use `foreman stage-token` to record stage token PASS states. Advancing stages requires preceding stage tokens (`PLAN`, `BUILD`, `VERIFY`, `QA`, `SECURITY`, `NO_MISTAKES`, `PR`) to be in `PASS` state.
- GitHub Identity Guard: The `push` and `pr` commands verify the active GitHub login is exactly `Samueljug` before executing writes.
- Quarantine: Active runs are blocked if they are dirty, shared with other active runs, or stale. Clear quarantine with `quarantine --run RUN_DIR --clear true`.
- Use `review-gate` or `claude-judge` for independent model/judge review, so HEAD and diff hashes are captured.
- Record `improver_review` evidence and a `self_improvement` PASS gate before Ship to PR, Done, closed, or final disposition. No-op reviews still need a report artifact, ledger event, owner/reviewer, non-empty source coverage, missing coverage, and Paperclip-visible comment for Paperclip-backed runs.
- Use `pr-status --require-eligible` before claiming a PR-backed ticket is ready for Done.
- For Paperclip-backed (`OPE-*`) runs, `evidence-check`, `ready`, `push`, `pr`, and `pr-status --require-eligible` fail closed when required Paperclip Option B comments/attachments are missing, including self-improvement/no-op comments. `paperclip-audit` inspects the board-side evidence without mutating Paperclip.

## Failure Modes

- `ready` can fail because the repository worktree is dirty even when evidence and gates are present.
- A PASS review gate can go stale after any code change.
- Browser QA PASS fails if screenshot-backed artifacts are missing.
- Stage token mismatch: missing preceding stage tokens will block stage advancement (`advance`).
- Publishing with a mismatched GitHub profile username will block `push` and `pr`.
- Quarantine will block run status/readiness if the worktree is dirty, shared, or the run has grown stale.
- Self-improvement PASS fails if the details omit an owner/reviewer, allowed improver verdict, non-empty source coverage, missing coverage, or the report artifact path; readiness also fails when `improver_review` evidence is missing.
- Paperclip-backed UI/browser tickets fail readiness unless Paperclip has image/video attachment evidence; local run-folder screenshots alone are insufficient.
- Paperclip API/config ambiguity is reported as `decisionNeeded`; the coordinator must return it visibly to Samuel/OpenClaw and Paperclip.
- `pr-status` has no URL unless the PR gate recorded one or `--url` is provided.

## When This Changes, Update

- [Foreman CLI](foreman-cli.md) if command semantics change.
- [Runbooks](runbooks.md) if operator sequences change.
- [Gate Readiness Matrix](gate-readiness-matrix.md) if gate preconditions change.
