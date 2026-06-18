# Runbooks

Backlinks: [Wiki Home](README.md), [Foreman Command Reference](foreman-command-reference.md)

## Purpose

Provide concise operational sequences for common Dark Factory tasks.

## How It Works

Use these as operator checklists. They intentionally prefer Foreman and Paperclip helpers over manual file edits.

## Key Files And Commands

### Start A Run

```bash
node tools/dark-factory/foreman.mjs validate --workorder path/to/workorder.json
node tools/dark-factory/foreman.mjs start --workorder path/to/workorder.json
node tools/paperclip-board/factory-log.mjs coverage --issue OPE-123
```

### Record Stage And Evidence

```bash
node tools/dark-factory/foreman.mjs advance --run RUN_DIR --stage "Verification" --summary "implementation handoff complete"
node tools/dark-factory/foreman.mjs evidence --run RUN_DIR --kind test --path output.txt --summary "targeted tests passed"
node tools/dark-factory/foreman.mjs evidence-check --run RUN_DIR
```

### Browser QA

```bash
node tools/dark-factory/foreman.mjs browser-qa --run RUN_DIR --report browser-qa-report.md --screenshot screenshot.png --summary "browser QA passed"
```

### No Mistakes And PR

```bash
node tools/dark-factory/foreman.mjs ready --run RUN_DIR
node tools/dark-factory/foreman.mjs no-mistakes --run RUN_DIR
node tools/dark-factory/foreman.mjs push --run RUN_DIR --remote origin --branch branch-name
node tools/dark-factory/foreman.mjs pr --run RUN_DIR --title "..." --body "..."
node tools/dark-factory/foreman.mjs pr-status --run RUN_DIR --require-eligible
```

### Watchers And Health

```bash
node tools/paperclip-board/pr-task-sweeper.mjs --apply
node tools/paperclip-board/pr-review-watcher.mjs --apply
node tools/dark-factory/loop-health-report.mjs --days 7 --markdown
node tools/dark-factory/worktree-health.mjs check --markdown
```

### Intake And Handoff

Run these from `/Users/samuelimini/.openclaw/workspace-development`:

```bash
node tools/factory-intake/factory-intake.mjs --raw "TASK: ..." --chat-id "telegram:508625244" --message-id "123"
node tools/factory-intake/process-media.mjs --input ~/.openclaw/media/inbound/repro.mp4 --out-dir tools/factory-intake/state/media-artifacts
node tools/factory-intake/factory-foreman.mjs --max 5 --dry-run
node tools/factory-intake/factory-foreman.mjs --max 5
node tools/factory-intake/clickup-sync.mjs --import --dry-run
```

Use the scheduled foreman to claim/handoff Paperclip Todo cards. Use `tools/dark-factory/foreman.mjs` only after a WorkOrder-backed run exists.

### Foreman LaunchAgent

See [LaunchAgent Foreman Daemon](launchagent-foreman-daemon.md).

## Source Files Inspected

- [../README.md](../README.md)
- [../foreman.mjs](../foreman.mjs)
- [../../paperclip-board/README.md](../../paperclip-board/README.md)
- [../../paperclip-board/factory-log.mjs](../../paperclip-board/factory-log.mjs)
- [intake-foreman-scheduling.md](intake-foreman-scheduling.md)
- `<FORK>/dark-factory/intake/README.md`
- [launchagent-foreman-daemon.md](launchagent-foreman-daemon.md)

## Invariants And Guardrails

- Prefer command paths over manual JSON edits.
- Use `left-aside` for useful out-of-scope notes rather than expanding scope.
- Run `factory-foreman.mjs --dry-run` before manual diagnosis if you only need to see eligible Todo handoffs.
- Do not mark a PR-backed ticket Done without PR status eligibility.
- Use `--apply` watchers only when mutating board state is intended.

## Failure Modes

- Running No Mistakes or PR commands outside Foreman bypasses the typed gate chain.
- `--mark-stale-blocked` and watcher `--apply` mutate board/run state.
- Browser QA cannot pass without recorded artifacts.
- `gh` and local board/API commands can fail when auth or services are unavailable.
- Intake commands can mutate Paperclip and external ClickUp state; use `--dry-run` where available during diagnosis.

## When This Changes, Update

- [Foreman Command Reference](foreman-command-reference.md) if command syntax changes.
- [Paperclip Watchers](paperclip-watchers.md) if watcher workflows change.
- [Factory Intake And Foreman Scheduling](intake-foreman-scheduling.md) if intake or handoff commands change.
- [LaunchAgent Foreman Daemon](launchagent-foreman-daemon.md) if daemon startup changes.
