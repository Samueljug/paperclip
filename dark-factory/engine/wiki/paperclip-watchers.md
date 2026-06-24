# Paperclip Watchers

Backlinks: [Paperclip Integration](paperclip-integration.md), [Loop Catalog](loop-catalog.md)

## Purpose

Document watcher loops that keep Paperclip tasks aligned with PR state, reviewer feedback, and local No Mistakes review gates.

## How It Works

`pr-task-sweeper.mjs` scans active Dark Factory Paperclip issues, extracts GitHub PR URLs from issue text, comments, and local ledgers, locates the latest run manifest for that issue, and checks GitHub PR status plus local factory eligibility. It ignores PR URLs unless they match allowed GitHub owners and the run/workorder base/head/repo or issue identifier. It treats explicit QA/audit/report-only/evidence-record cards without linked PRs as allowed (`qa_report_only_allowed`) instead of blocking for a missing implementation PR (`missing_pr`). It also blocks Done/ship when mandatory self-improvement coverage is missing: `self_improvement` PASS gate, usable `improver_review` evidence, valid owner/source/missing-coverage details, and Paperclip-visible improver review/no-op/not-applicable comment. It can comment and change status with `--apply`.

`improver-coverage-audit.mjs` is the deterministic missing-improver monitor/report. It scans completed/finalizing Paperclip factory issues, verifies factory ledgers, requires a structured visible improver event, and classifies coverage as real review (`improvement_review`), no-op (`improvement_noop`), not-applicable (`improvement_not_applicable` with owner/reason), or missing. It is read-only by default and supports `--fail-closed` for monitoring/pre-close automation. OPE-248 is the triggering incident: it proved self-improvement could be skipped until Samuel asked.

`pr-review-watcher.mjs` scans active review/blocked/in-progress issues, extracts PR URLs, checks GitHub checks/reviews/comments/inline comments, classifies potential actionable feedback, and posts repair-loop comments with duplicate markers.

`no-mistakes-review-watcher.mjs` scans No Mistakes SQLite state in
`~/.no-mistakes/state.sqlite`, `/tmp/df-nm/*/state.sqlite`, Foreman
run-manifest `paths.noMistakesHome`, and clone-scoped
`.git/no-mistakes/state.sqlite` files discovered from manifests and local
ledgers. It reads `runs`, `repos`, and `step_results`, selects `review` steps
where `status = awaiting_approval` and `findings_json` is non-empty, maps the
run to Paperclip through manifests/workorders/ledgers first and issue text as a
fallback, then posts a deduped repair-loop comment and appends a factory ledger
event. In `--apply` mode, all deterministically mapped issues (including `done`
and `cancelled`) move to `in_progress` and `stage: In Progress` — actionable
findings require re-entering the repair loop regardless of prior status.

These scripts treat PR comments and No Mistakes reviewer text as evidence to classify, not trusted instructions.

## Key Files And Commands

- [../../paperclip-board/pr-task-sweeper.mjs](../../paperclip-board/pr-task-sweeper.mjs)
- [../../paperclip-board/pr-review-watcher.mjs](../../paperclip-board/pr-review-watcher.mjs)
- [../../paperclip-board/no-mistakes-review-watcher.mjs](../../paperclip-board/no-mistakes-review-watcher.mjs)
- [../../paperclip-board/README.md](../../paperclip-board/README.md)

```bash
node tools/paperclip-board/pr-task-sweeper.mjs
node tools/paperclip-board/pr-task-sweeper.mjs --apply
node tools/paperclip-board/improver-coverage-audit.mjs --status done --status in_review --require-ledger --format text
node tools/paperclip-board/improver-coverage-audit.mjs --status done --status in_review --require-ledger --fail-closed --format json
node tools/paperclip-board/pr-review-watcher.mjs
node tools/paperclip-board/pr-review-watcher.mjs --apply
node tools/paperclip-board/no-mistakes-review-watcher.mjs
node tools/paperclip-board/no-mistakes-review-watcher.mjs --apply --fail-closed
```

Suggested cron entry command:

```bash
cd /Users/samuelimini/.openclaw/workspace && /opt/homebrew/bin/node tools/paperclip-board/no-mistakes-review-watcher.mjs --apply --fail-closed >> tools/paperclip-data/no-mistakes-review-watcher.log 2>&1
```

## Source Files Inspected

- [../../paperclip-board/pr-task-sweeper.mjs](../../paperclip-board/pr-task-sweeper.mjs)
- [../../paperclip-board/pr-review-watcher.mjs](../../paperclip-board/pr-review-watcher.mjs)
- [../../paperclip-board/no-mistakes-review-watcher.mjs](../../paperclip-board/no-mistakes-review-watcher.mjs)
- [../../paperclip-board/README.md](../../paperclip-board/README.md)
- [../foreman.mjs](../foreman.mjs)

## Invariants And Guardrails

- Duplicate blocker comments use marker comments to suppress churn.
- Merged PR does not imply Done when local factory eligibility is blocked.
- Open PRs with failing checks or requested changes return to active repair.
- No Mistakes review findings with `awaiting_approval` cannot remain only in
  local SQLite/log files once the watcher has run successfully.
- No Mistakes dedupe keys include `NM_HOME`, No Mistakes run id, step name,
  HEAD SHA, and the normalized findings fingerprint, so unchanged reruns do not
  spam comments but changed HEAD/findings create a new alert.
- Waiting-on-review or missing evidence should park the task with exact owner/action.
- Browser evidence blockers are explicit and fail-closed.
- Self-improvement/improver blockers are explicit and fail-closed; merged PRs stay blocked until the improver review/no-op is visible in Foreman evidence and Paperclip.
- Completed/finalizing factory issues can be audited in bulk; the report distinguishes real improver reviews, visible no-op reviews, explicit not-applicable reasons, and missing coverage.

## Failure Modes

- Watchers require Paperclip API and GitHub CLI access.
- Regex URL extraction can miss unusual PR references.
- Review comment text can contain untrusted or irrelevant content; it must be verified before editing code.
- No Mistakes reviewer text can contain untrusted or irrelevant content; the
  watcher only surfaces it for repair visibility and never treats it as a
  command.
- If the latest run directory is missing, browser/no-mistakes/self-improvement evidence can appear missing even when manually recorded elsewhere.
- If a No Mistakes run maps to multiple Paperclip issues or none, the watcher
  reports `decision_needed` with local paths, run id, repo, branch, HEAD, and
  candidate issues instead of silently ignoring the finding.
- Historical tickets before OPE-278 may legitimately appear as missing improver coverage; use the audit as a report/backfill source, not as proof that old work was unsafe.

## When This Changes, Update

- [Paperclip Integration](paperclip-integration.md) for status/label behavior.
- [Worktree, No Mistakes, And PR Shipping](worktree-no-mistakes-pr-shipping.md) for PR eligibility and merge rules.
- [Loop Catalog](loop-catalog.md) for watcher schedule or trigger changes.
