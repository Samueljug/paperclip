# Paperclip Integration

Backlinks: [Wiki Home](README.md), [Paperclip Watchers](paperclip-watchers.md)

## Purpose

Document how the local Paperclip board, task helpers, factory ledgers, improvement reports, and watcher loops connect to Dark Factory.

## How It Works

Paperclip is the visible communication and status surface. It is loopback-only at `http://127.0.0.1:3101`. Factory helpers create tasks, add labels, initialize ledgers, append hash-chained events, post optional comments, and create improvement reports. Watchers reconcile PR state and review findings back into board status.

Paperclip plugins extend the board: `darkfactory.team-templates` (per-team model templates), `samuel.plugin-llm-accounts` (LLM account routing), and `darkfactory.brief-coverage-gate` (blocks issues lacking a complete brief manifest / clean coverage matrix — see [Brief Coverage Gate](brief-coverage-gate.md)).

The `workspace-development/tools/factory-intake` tools are a separate Paperclip front door. They create Telegram/ClickUp-sourced Todo cards, add source/gate labels, attach local media evidence when provided, and run the scheduled Todo handoff foreman that claims cards and sends them to `pi-orchestrator`.

The append-only ledger is the durable event history for a task. Each issue gets:

```text
tools/paperclip-data/factory-run-ledgers/<issue>/
  manifest.json
  events.jsonl
```

`ledger-lib.mjs` uses a lock file, fsync appends, and event hashes linked by `prevHash`.

## Key Files And Commands

- [../../paperclip-board/README.md](../../paperclip-board/README.md)
- [../../paperclip-board/create-task.mjs](../../paperclip-board/create-task.mjs)
- [../../paperclip-board/factory-log.mjs](../../paperclip-board/factory-log.mjs)
- [../../paperclip-board/ledger-lib.mjs](../../paperclip-board/ledger-lib.mjs)
- [../../paperclip-board/create-improvement-report.mjs](../../paperclip-board/create-improvement-report.mjs)
- [../../paperclip-data/factory-run-ledgers/README.md](../../paperclip-data/factory-run-ledgers/README.md)
- [intake-foreman-scheduling.md](intake-foreman-scheduling.md)
- `<FORK>/dark-factory/intake/factory-intake.mjs`
- `<FORK>/dark-factory/intake/factory-foreman.mjs`
- `<FORK>/dark-factory/intake/clickup-sync.mjs`

```bash
node tools/paperclip-board/create-task.mjs --title "..." --brief "..."
node tools/paperclip-board/factory-log.mjs event --issue OPE-123 --type stage_changed --actor planning-lead --summary "..."
node tools/paperclip-board/factory-log.mjs verify --issue OPE-123
node tools/paperclip-board/factory-log.mjs coverage --issue OPE-123
node tools/paperclip-board/create-improvement-report.mjs --source OPE-123 --summary "..."
node tools/factory-intake/factory-intake.mjs --raw "TASK: ..." --chat-id "telegram:508625244" --message-id "123"
node tools/factory-intake/factory-foreman.mjs --max 5 --dry-run
```

## Source Files Inspected

- [../../paperclip-board/README.md](../../paperclip-board/README.md)
- [../../paperclip-board/create-task.mjs](../../paperclip-board/create-task.mjs)
- [../../paperclip-board/factory-log.mjs](../../paperclip-board/factory-log.mjs)
- [../../paperclip-board/ledger-lib.mjs](../../paperclip-board/ledger-lib.mjs)
- [../../paperclip-board/create-improvement-report.mjs](../../paperclip-board/create-improvement-report.mjs)
- [../../paperclip-data/factory-run-ledgers/README.md](../../paperclip-data/factory-run-ledgers/README.md)
- `<FORK>/dark-factory/intake/README.md`
- `<FORK>/dark-factory/intake/factory-intake.mjs`
- `<FORK>/dark-factory/intake/factory-foreman.mjs`
- `<FORK>/dark-factory/intake/clickup-sync.mjs`
- representative coverage for OPE-36 and OPE-202, summarized in [WorkOrders And Runs](workorders-runs.md)

## Invariants And Guardrails

- Do not store secrets or hidden chain-of-thought in ledgers.
- Store observable events, handoffs, decisions, rationale summaries, artifact paths/URLs, approvals, blockers, gate results, and source refs.
- Improvement reports default to Backlog and are not approval to mutate live behavior.
- Paperclip status alone is not proof that Foreman gates passed.
- Paperclip Todo handoff is not proof that a deterministic Foreman run exists.
- Intake local config and ClickUp credentials must not be pasted into board comments, ledgers, or docs.
- Board is loopback-only unless Samuel explicitly approves exposure.

## Failure Modes

- Paperclip API helpers require the local board service and labels/projects to exist.
- Ledger verification can fail if events are edited manually.
- Optional `--comment` posting requires an issue id in the ledger manifest or CLI args.
- Improvement report labels must exist on the board; missing labels block creation.
- Scheduled intake handoff fails if required stage labels, Paperclip API config, or coms-net `pi-orchestrator` routing are unavailable.

## When This Changes, Update

- [Paperclip Watchers](paperclip-watchers.md) when sweeper/review watcher logic changes.
- [Factory Intake And Foreman Scheduling](intake-foreman-scheduling.md) when Telegram/ClickUp/manual intake or scheduled Todo claim/handoff changes.
- [Source Map](source-map.md) if board project ids, helper files, or ledger locations change.
- [Operating Model](operating-model.md) if status semantics or approval queues change.
