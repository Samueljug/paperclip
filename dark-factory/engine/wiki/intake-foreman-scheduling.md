# Factory Intake And Foreman Scheduling

Backlinks: [Wiki Home](README.md), [Architecture](architecture.md), [Operating Model](operating-model.md), [LaunchAgent Foreman Daemon](launchagent-foreman-daemon.md)

## Purpose

Document the `workspace-development/tools/factory-intake` source area and how its scheduled intake/handoff foreman fit with the deterministic Dark Factory Foreman CLI in `tools/dark-factory`.

> **⚠️ STOPPED since the 2026-06-13 cutover (verified 2026-06-15).** The
> scheduled intake/handoff foreman described on this page is **no longer
> running**: the `com.openclaw.dark-factory-foreman` LaunchAgent is unloaded
> (`launchctl list`/`launchctl print` show it absent), and the coms-net
> `pi-orchestrator` handoff target runs as a Paperclip agent now, not a tmux
> session. Keep this page as the **restore reference** (see
> `paperclip-migration/cutover-backup/restore-notes.md`). The `factory-intake.mjs`
> ticket-creator may still be run by hand; the _scheduled handoff_ does not run.
> Current routing is Paperclip heartbeat / assignment wakeups — see
> [Architecture](architecture.md).

## How It Works

This source area is the front door and scheduled handoff layer for Development Telegram, ClickUp, and manual Paperclip Todo work. It is not the same runner as [Foreman CLI](foreman-cli.md).

The flow is:

1. `factory-intake.mjs` turns explicit Telegram-style requests into Paperclip issues. It requires a `TASK:`, `TICKET:`, `DF:`, `/task`, `/ticket`, or `tasks:` prefix unless `--force` is used. It can split multiple bullet tasks, create a dedupe key from chat/message/index, add source and gate labels, attach local media artifacts, and append a `telegram_intake_task_created` ledger event.
2. `process-media.mjs` is an optional local preprocessor. It uses `ffprobe`/`ffmpeg` to inspect media and extract video frames, and uses `whisper` when audio transcription is available. It writes a media manifest under the local intake state tree for `factory-intake.mjs` to include in the Paperclip issue.
3. `clickup-sync.mjs` is an opt-in bridge from configured ClickUp lists into Paperclip Todo. It reads ClickUp auth from environment variables or macOS Keychain, imports matching statuses only when an import flag is passed, and can back-sync Paperclip review/done state to the source ClickUp task's review status.
4. `factory-foreman.mjs` is the scheduled handoff daemon. The LaunchAgent runs it every 60 seconds with `--max 5` from `/Users/samuelimini/.openclaw/workspace-development`. It lists Paperclip `todo` issues, skips issues already handed off for the same ready fingerprint, atomically checks out an issue, moves its stage label to `stage: In Progress`, appends ledger events, registers a temporary `paperclip-todo-foreman` sender in coms-net, resolves exactly one online `pi-orchestrator`, and sends a handoff prompt.
5. After handoff, `pi-orchestrator` owns routing to a separate factory cell. That cell may use `tools/dark-factory/foreman.mjs` to create a WorkOrder-backed run, record evidence, pass gates, run No Mistakes, push, and create or check a PR. The intake foreman does not create `RunManifest`, `EvidencePack`, `GateResult`, or PR artifacts itself.

Manual Paperclip cards also enter through the same scheduled foreman when they are Todo-ready. The handoff source label is inferred from markers/labels as Telegram factory intake, ClickUp sync, or Paperclip Todo.

## Key Files And Commands

- `<FORK>/dark-factory/intake/README.md`
- `<FORK>/dark-factory/intake/factory-intake.mjs`
- `<FORK>/dark-factory/intake/process-media.mjs`
- `<FORK>/dark-factory/intake/clickup-sync.mjs`
- `<FORK>/dark-factory/intake/factory-foreman.mjs`
- `<FORK>/dark-factory/intake/config.example.json`
- `<FORK>/dark-factory/intake/clickup.config.example.json`
- `/Users/samuelimini/Library/LaunchAgents/com.openclaw.dark-factory-foreman.plist`
- [../foreman.mjs](../foreman.mjs)

```bash
node tools/factory-intake/factory-intake.mjs --raw "TASK: Fix the login page bug" --chat-id "telegram:508625244" --message-id "123"
node tools/factory-intake/process-media.mjs --input ~/.openclaw/media/inbound/repro.mp4 --out-dir tools/factory-intake/state/media-artifacts
node tools/factory-intake/factory-foreman.mjs --max 5
node tools/factory-intake/factory-foreman.mjs --max 5 --dry-run
node tools/factory-intake/clickup-sync.mjs --import --dry-run
node tools/factory-intake/clickup-sync.mjs --backsync-only
node tools/dark-factory/foreman.mjs start --workorder path/to/workorder.json
```

LaunchAgent inspection:

```bash
plutil -p ~/Library/LaunchAgents/com.openclaw.dark-factory-foreman.plist
tail -n 80 ~/.openclaw/logs/dark-factory-foreman.out.log
tail -n 80 ~/.openclaw/logs/dark-factory-foreman.err.log
```

## Source Files Inspected

- `<FORK>/dark-factory/intake/README.md`
- `<FORK>/dark-factory/intake/factory-intake.mjs`
- `<FORK>/dark-factory/intake/factory-intake.test.mjs`
- `<FORK>/dark-factory/intake/process-media.mjs`
- `<FORK>/dark-factory/intake/clickup-sync.mjs`
- `<FORK>/dark-factory/intake/config.example.json`
- `<FORK>/dark-factory/intake/clickup.config.example.json`
- `<FORK>/dark-factory/intake/factory-foreman.mjs`
- `<FORK>/dark-factory/intake/factory-foreman.test.mjs`
- `/Users/samuelimini/Library/LaunchAgents/com.openclaw.dark-factory-foreman.plist`
- `/Users/samuelimini/.openclaw/logs/dark-factory-foreman.out.log`
- `/Users/samuelimini/.openclaw/logs/dark-factory-foreman.err.log`
- [../foreman.mjs](../foreman.mjs)

`config.local.json` and `clickup.local.json` were intentionally not inspected because they can contain local IDs, tokens, or service configuration.

## Invariants And Guardrails

- The intake foreman only hands Paperclip Todo-ready issues to `pi-orchestrator`; it does not route directly to team leads or workers.
- A claimed issue must be checked out atomically before handoff and should be idempotent for the same Todo ready fingerprint.
- The scheduled foreman must use local config/env secrets without printing them. Do not paste local config or long raw logs into documentation.
- Telegram intake should carry a source marker, source label, dedupe key, original brief, and any media evidence summary needed by downstream agents.
- Media-heavy tickets should include written transcript/frame/summary evidence before orchestration; raw video alone is not enough when visual details matter.
- ClickUp sync imports are opt-in; a bare command prints usage/error instead of creating cards.
- `tools/dark-factory/foreman.mjs` remains the mechanical run/gate/shipping authority once a ticket is routed into a WorkOrder-backed factory run.

## Failure Modes

- The LaunchAgent can be healthy while no deterministic Foreman run exists for a handed-off ticket.
- Missing Paperclip labels, project IDs, coms-net credentials, or a unique online `pi-orchestrator` cause handoff failure.
- If handoff fails repeatedly, `factory-foreman.mjs` releases or blocks the Paperclip issue according to retry count and configured limits.
- If a Todo issue is requeued with a later update fingerprint, it is eligible for another handoff.
- `process-media.mjs` depends on local `ffprobe`, `ffmpeg`, and optionally `whisper`; missing tools or unsupported media block artifact generation.
- ClickUp sync depends on external ClickUp API access and local token setup, so it is not a credential-free conformance path.

## When This Changes, Update

- [LaunchAgent Foreman Daemon](launchagent-foreman-daemon.md) if launchd path, schedule, arguments, working directory, logs, or daemon semantics change.
- [Paperclip Integration](paperclip-integration.md) if labels, statuses, ledger event types, comments, or issue creation/claim behavior change.
- [Operating Model](operating-model.md) if the handoff boundary between intake foreman, `pi-orchestrator`, and Foreman CLI changes.
- [Foreman CLI](foreman-cli.md) if the deterministic runner begins ingesting intake cards directly or the intake foreman starts creating run artifacts.
- [Source Map](source-map.md) whenever files in `<FORK>/dark-factory/intake` become authoritative, move, or stop governing behavior.
