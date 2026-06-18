# Gate Readiness Matrix

Backlinks: [Evidence And Gates](evidence-gates.md), [Foreman CLI](foreman-cli.md)

## Purpose

Summarize the current fail-closed readiness checks in one place.

## How It Works

`readinessReport()` in `foreman.mjs` builds a failure list. `ready`, `push`, and `pr` rely on this report. `push` and `pr` do not run their external commands if readiness fails.

## Key Files And Commands

| Check | Source | Blocks When |
| --- | --- | --- |
| Ledger | `verifyLedger(issue)` | ledger missing, empty, or hash chain invalid |
| Worktree | `worktreeHealthForRun()` | repo dirty or cannot be scanned |
| Plan adversarial review | `planAdversarialReviewFailures()` | required one-shot planning challenge not PASS exactly once |
| TestContract | `testContractFailures()` | required contract missing, not frozen, or hash changed |
| Scope | `scopeFailures()` | diff touches files outside `allowedWriteScope` or inside `protectedPaths` |
| Loop state | `manifest.loop`, `manifest.loops[]` | any loop exhausted before PASS |
| Required gate | `requiredGates()` | missing gate or verdict not PASS |
| Test gate freshness | `boundTestGateFailures()` | visible or holdout PASS is stale against HEAD, diff hash, or TestContract hash |
| Browser QA | `browserEvidenceFailures()` | missing PASS, report, screenshot, or complete waiver |
| No Mistakes | gate details | approved HEAD differs from current HEAD |
| Self-improvement / improver | `requiredGates()`, `selfImprovementFailures()` | missing `self_improvement` PASS, missing `improver_review` artifact, missing verdict/source/missing-coverage details, or not-applicable without owner/reason |
| Model/judge review | gate details | reviewed HEAD or diff hash stale |
| Evidence | `evidenceFailures()` | required evidence kind missing or unusable |
| Paperclip evidence | `paperclipEvidenceAudit()` | Paperclip-backed run is missing required Option B comments/attachments, including self-improvement/no-op comments, or API/config is ambiguous and needs Samuel decision |
| PR eligibility | `pr-status --require-eligible` | checks/reviews/reviewer requests/No Mistakes binding/Paperclip Done evidence blocked |

Commands:

```bash
node tools/dark-factory/foreman.mjs ready --run RUN_DIR
node tools/dark-factory/foreman.mjs ready --run RUN_DIR --include-pr
node tools/dark-factory/foreman.mjs paperclip-audit --run RUN_DIR --mode ship_to_pr
node tools/dark-factory/foreman.mjs run-tests --run RUN_DIR --suite visible --phase post --expect pass
node tools/dark-factory/foreman.mjs evidence --run RUN_DIR --kind improver_review --path reports/improver-noop-review.md --summary "improver no-op review"
node tools/dark-factory/foreman.mjs record-gate --run RUN_DIR --gate self_improvement --verdict PASS --summary "improver review complete" --details-json '{"improverVerdict":"noop","owner":"self-improvement-lead","sourceCoverage":["ledger","run artifacts"],"missingCoverage":"none"}' --path reports/improver-noop-review.md
node tools/dark-factory/foreman.mjs pr-status --run RUN_DIR --require-eligible
```

## Source Files Inspected

- [../foreman.mjs](../foreman.mjs)
- [../worktree-health.mjs](../worktree-health.mjs)
- [../../paperclip-board/ledger-lib.mjs](../../paperclip-board/ledger-lib.mjs)
- [../../paperclip-board/pr-task-sweeper.mjs](../../paperclip-board/pr-task-sweeper.mjs)

## Invariants And Guardrails

- Readiness reports concrete failure objects; do not collapse them to "not ready" in reports.
- Foreman PR eligibility overrides GitHub merge appearance.
- Paperclip evidence is additive and fail-closed: comments/attachments cannot substitute for real Foreman gates, but missing board-visible evidence blocks Paperclip-backed shipping.
- Self-improvement is mandatory factory coverage, not an optional after-action. No-op and not-applicable outcomes must be explicit and visible.
- No Mistakes and PR gates must bind to exact current head/base context.
- Test gates must bind to exact current head/diff context and to the frozen TestContract hash when one exists.
- Dirty worktree checks are report-only; they do not stash, commit, revert, or delete.

## Failure Modes

- Worktree dirtiness in unrelated untracked tool files can block conformance or ready checks if the run's repo is the workspace.
- Review request usernames are normalized for comparison, but reviewer routing still depends on repo URL/name matching.
- PR check parsing depends on `gh pr view` JSON shape.

## When This Changes, Update

- [Evidence And Gates](evidence-gates.md) if gate categories change.
- [Foreman Command Reference](foreman-command-reference.md) if operators need new commands.
- [Paperclip Watchers](paperclip-watchers.md) if sweeper blocker logic changes.
