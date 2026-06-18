# LaunchAgent Foreman Daemon

Backlinks: [Runbooks](runbooks.md), [Paperclip Integration](paperclip-integration.md), [Factory Intake And Foreman Scheduling](intake-foreman-scheduling.md)

## Purpose

Document what macOS launchd started for the Paperclip Todo intake/handoff foreman.

> **⚠️ STOPPED since the 2026-06-13 cutover (verified 2026-06-15).** This
> LaunchAgent (`com.openclaw.dark-factory-foreman`) is **unloaded** — the `.plist`
> still sits in `~/Library/LaunchAgents/` but `launchctl list` does not show it
> and `launchctl print` returns nothing for it. The improver-monitor and
> no-mistakes-review-watcher LaunchAgents are likewise not loaded. The only
> openclaw LaunchAgent still running is `ai.openclaw.gateway`. Scheduling moved
> into Paperclip's heartbeat. Treat this page as the restore reference.

## How It Works

The LaunchAgent `com.openclaw.dark-factory-foreman` starts a background Node process every 60 seconds and at load. Its working directory is `/Users/samuelimini/.openclaw/workspace-development`, and it runs:

```text
/opt/homebrew/Cellar/node/26.0.0/bin/node <FORK>/dark-factory/intake/factory-foreman.mjs --max 5
```

The script claims Todo-ready Paperclip issues, moves their stage label to In Progress, appends ledger events, registers a temporary `paperclip-todo-foreman` coms-net sender, resolves exactly one online `pi-orchestrator`, sends a handoff prompt, posts a Paperclip comment, and records handoff state. It is a scheduled intake/handoff foreman from `<FORK>/dark-factory/intake`, not the same as `tools/dark-factory/foreman.mjs`.

The deterministic Foreman CLI only begins after a routed worker or orchestrator creates or advances a WorkOrder-backed run. This daemon does not write `RunManifest`, `EvidencePack`, `GateResult`, No Mistakes, push, or PR artifacts.

Recent stdout showed repeated `No unclaimed Todo-ready tasks` messages plus successful claims/handoffs for OPE-153, OPE-152, OPE-151, and OPE-202. Stderr was empty at inspection time. This page intentionally does not paste long logs or secrets.

## Key Files And Commands

- `/Users/samuelimini/Library/LaunchAgents/com.openclaw.dark-factory-foreman.plist`
- `<FORK>/dark-factory/intake/README.md`
- `<FORK>/dark-factory/intake/factory-foreman.mjs`
- `<FORK>/dark-factory/intake/config.example.json`
- `/Users/samuelimini/.openclaw/logs/dark-factory-foreman.out.log`
- `/Users/samuelimini/.openclaw/logs/dark-factory-foreman.err.log`

Inspection commands:

```bash
plutil -p ~/Library/LaunchAgents/com.openclaw.dark-factory-foreman.plist
tail -n 80 ~/.openclaw/logs/dark-factory-foreman.out.log
tail -n 80 ~/.openclaw/logs/dark-factory-foreman.err.log
```

## Source Files Inspected

- `/Users/samuelimini/Library/LaunchAgents/com.openclaw.dark-factory-foreman.plist`
- `<FORK>/dark-factory/intake/README.md`
- `<FORK>/dark-factory/intake/factory-foreman.mjs`
- `<FORK>/dark-factory/intake/factory-foreman.test.mjs`
- `<FORK>/dark-factory/intake/config.example.json`
- `/Users/samuelimini/.openclaw/logs/dark-factory-foreman.out.log`
- `/Users/samuelimini/.openclaw/logs/dark-factory-foreman.err.log`

## Invariants And Guardrails

- The daemon should claim Paperclip Todo tasks atomically through the board API.
- It should dedupe handoffs by current Todo ready fingerprint.
- It should retry handoff failures and block after the configured retry cap.
- It should log only observable handoff state and not secrets.
- It should hand off only to `pi-orchestrator`; specialist routing belongs after orchestration.

## Failure Modes

- If `pi-orchestrator` is offline or ambiguous, handoff fails and retry/block logic applies.
- If labels `stage: In Progress` or `stage: To Do` are missing, the run fails.
- If config lacks Paperclip or coms-net credentials, startup fails.
- This daemon does not create Foreman run manifests by itself.
- A successful launchd run can still leave the ticket waiting if `pi-orchestrator` does not continue routing.

## When This Changes, Update

- [Factory Intake And Foreman Scheduling](intake-foreman-scheduling.md) if schedule, path, claim, retry, or handoff semantics change.
- [Paperclip Integration](paperclip-integration.md) if handoff/claim semantics change.
- [Operating Model](operating-model.md) if this daemon starts owning more than handoff.
- [Source Map](source-map.md) if the script path, label, or launchd paths change.
