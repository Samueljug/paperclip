# Telemetry

Backlinks: [Wiki Home](README.md), [Loops And Self-Improvement](loops-self-improvement.md)

## Purpose

Document post-merge telemetry and loop-health reporting.

## How It Works

`post-merge-telemetry.mjs` is source-adapter shaped but currently minimal. It checks an error log from `--error-log` or `DARK_FACTORY_TELEMETRY_LOG`, compares it with an optional baseline, and reports `HEALTHY` or `ALERT` based on threshold count and ratio. If no error log or adapter signal exists, it exits ok with `status=not_configured` and `verdict=SKIPPED`.

`loop-health-report.mjs` summarizes recent runs and ledgers: active/blocked/stale runs, exhausted loops, dirty worktrees, loop iterations, gate failures, repeated blockers, and recommendations. With `--mark-stale-blocked`, it mutates stale active manifests to blocked and appends ledger events.

## Key Files And Commands

- [../post-merge-telemetry.mjs](../post-merge-telemetry.mjs)
- [../loop-health-report.mjs](../loop-health-report.mjs)
- [../worktree-health.mjs](../worktree-health.mjs)

```bash
node tools/dark-factory/post-merge-telemetry.mjs check --pr-url https://github.com/org/repo/pull/1
node tools/dark-factory/post-merge-telemetry.mjs check --pr-url URL --error-log errors.log --baseline-log baseline.log --fail-on-alert
node tools/dark-factory/loop-health-report.mjs --days 7 --markdown
node tools/dark-factory/loop-health-report.mjs --days 7 --stale-hours 12 --mark-stale-blocked
```

## Source Files Inspected

- [../post-merge-telemetry.mjs](../post-merge-telemetry.mjs)
- [../loop-health-report.mjs](../loop-health-report.mjs)
- [../worktree-health.mjs](../worktree-health.mjs)
- [../../../skills/dark-factory-loop-architecture/SKILL.md](../../../skills/dark-factory-loop-architecture/SKILL.md)

## Invariants And Guardrails

- `not_configured` is a visible setup gap, not a hidden pass.
- Telemetry alerts should create or claim a repair ticket and run the fix-test loop.
- Stale cleanup with `--mark-stale-blocked` is a mutating command; review samples before using it.
- Loop health should inform improvement reports, throttling, or retirement of noisy loops.

## Failure Modes

- Error-log line counts are a crude adapter; no Sentry or production adapter is fully wired in this script yet.
- Without a baseline, any errors above threshold can alert.
- Loop health depends on local run/ledger data and can miss externally tracked work.
- Marking stale active runs changes manifests and ledgers; use intentionally.

## When This Changes, Update

- [Loops And Self-Improvement](loops-self-improvement.md) if telemetry loop behavior changes.
- [Source Map](source-map.md) if a real telemetry adapter or data source is added.
- [Runbooks](runbooks.md) for new post-merge commands.

