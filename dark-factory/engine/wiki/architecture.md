# Architecture

Backlinks: [Wiki Home](README.md), [Source Map](source-map.md)

## Purpose

Explain the live architecture and how it relates to the long-form Dark Factory target architecture. The current system is a pilot: it has a deterministic Foreman CLI, local artifacts, Paperclip ledgers, watcher loops, Pi/OpenClaw protocols, and a first Foreman-owned TestContract path. It does not yet implement every target-design idea from the long-form docs, especially a full seeded-stack holdout judge.

> **⚠️ STALE since the 2026-06-13 cutover (verified 2026-06-15).** The "five
> load-bearing state surfaces" below describe the **pre-cutover** path where an
> external launchd foreman handed Todo cards to `pi-orchestrator` over coms-net
> and the Foreman CLI scheduled runs. That path is **stopped**. The live
> orchestrator is now **Paperclip's heartbeat scheduler** (30s loop,
> `server/src/services/heartbeat.ts`): it wakes the factory team — now ~51
> Paperclip agents (mostly `claude_local`, plus `codex_local`/`gemini_local`/
> `process`/`openclaw_gateway`) — and runs them via local CLI adapters in the
> Paperclip server process. `pi-orchestrator` and `OpenClaw Coordinator` are now
> Paperclip agents. The new end-to-end code pipeline is the
> [Conductor](conductor.md). `factory-intake.mjs` (human intake) and some gate
> watchers remain external; the openclaw **gateway** daemon still runs for the
> `openclaw_gateway` adapter. Read the surfaces below as the legacy/transitional
> reference, not the current scheduler.

## How It Works

The live architecture has five load-bearing state surfaces:

- `<FORK>/dark-factory/intake`: Telegram/ClickUp/manual intake and scheduled Paperclip Todo handoff. **(LaunchAgent STOPPED at the 2026-06-13 cutover — not loaded.)** When live, the LaunchAgent ran its `factory-foreman.mjs` every 60 seconds, claimed Todo-ready cards, and handed them to `pi-orchestrator`. Human intake via `factory-intake.mjs` still exists; the scheduled handoff no longer runs.
- `tools/dark-factory/foreman.mjs`: deterministic CLI runner. It validates WorkOrders, creates run directories, freezes TestContracts when required, mutates manifests and evidence packs under a per-run lock, records typed gate results, and blocks readiness when evidence, test oracles, loops, reviews, No Mistakes, protected paths, or worktree state are stale.
- `tools/paperclip-board/ledger-lib.mjs`: append-only, hash-chained task ledger. Foreman and Paperclip helpers append observable events into `tools/paperclip-data/factory-run-ledgers/<issue>/events.jsonl`.
- Paperclip board helpers: task creation, factory logging, improvement reports, PR sweepers, PR review watcher, and priority checks. These keep human-visible state and repair loops aligned with GitHub/Foreman.
- Pi/OpenClaw protocols: team routing, fresh work folders, relay gates, evidence standards, memory boundary, dynamic workflows, Webwright, No Mistakes, and review-to-skill governance.

The target design docs describe a broader future architecture: one instruction enters a Foreman/conductor, moves through intake, spec, plan, build, verify, gate, ship, and watch, and uses holdout scenarios plus an independent judge. In the current implementation, the CLI enforces the run/gate/artifact spine and can require visible plus holdout test suites through a frozen TestContract. The full scenario-author/scenario-judge, seeded full-stack environment, and folder-local factory DAG remain design targets or partial/protocol expectations.

## Key Files And Commands

- [../foreman.mjs](../foreman.mjs): live deterministic runner.
- [intake-foreman-scheduling.md](intake-foreman-scheduling.md): live intake and scheduled handoff layer.
- `<FORK>/dark-factory/intake/factory-foreman.mjs`: scheduled Paperclip Todo handoff foreman.
- `<FORK>/dark-factory/intake/factory-intake.mjs`: Development Telegram-to-Paperclip intake.
- [../README.md](../README.md): current command inventory and pilot limits.
- `/Users/samuelimini/Development/dark-factory/03-target-architecture.md`: target architecture and data model.
- `/Users/samuelimini/Development/dark-factory/04-pipeline-stages.md`: target eight-stage assembly line.
- [../../paperclip-board/ledger-lib.mjs](../../paperclip-board/ledger-lib.mjs): hash-chained ledger.
- [../../pi-vs-claude-code/.pi/openclaw-teams/dark-factory-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/dark-factory-protocol.md): pilot team and gate policy.

Core commands:

```bash
node tools/dark-factory/foreman.mjs validate --workorder path/to/workorder.json
node tools/dark-factory/foreman.mjs start --workorder path/to/workorder.json
node tools/dark-factory/foreman.mjs ready --run RUN_DIR
node tools/dark-factory/foreman.mjs pr-status --run RUN_DIR --require-eligible
node tools/paperclip-board/factory-log.mjs verify --issue OPE-123
```

## Source Files Inspected

- [../foreman.mjs](../foreman.mjs)
- [../README.md](../README.md)
- `<FORK>/dark-factory/intake/README.md`
- `<FORK>/dark-factory/intake/factory-foreman.mjs`
- `<FORK>/dark-factory/intake/factory-intake.mjs`
- [../../paperclip-board/ledger-lib.mjs](../../paperclip-board/ledger-lib.mjs)
- [../../paperclip-board/README.md](../../paperclip-board/README.md)
- [../../pi-vs-claude-code/.pi/openclaw-teams/dark-factory-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/dark-factory-protocol.md)
- [../../pi-vs-claude-code/.pi/openclaw-teams/parallel-project-isolation-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/parallel-project-isolation-protocol.md)
- `/Users/samuelimini/Development/dark-factory/03-target-architecture.md`
- `/Users/samuelimini/Development/dark-factory/04-pipeline-stages.md`

## Invariants And Guardrails

- Durable runner state belongs in WorkOrders, RunManifests, EvidencePacks, GateResult files, and ledger events, not hidden chat state.
- When testing is required, the oracle belongs to a verifier-owned TestContract before implementation. Builders can run visible tests, but holdout suites stay outside builder context by process and are run through Foreman.
- The LaunchAgent handoff foreman creates/claims Paperclip work; it does not by itself create deterministic run artifacts.
- Foreman never silently fixes or deletes worktree changes. Dirty worktrees block shipping gates.
- The implementer cannot be the only reviewer for non-trivial changes.
- Target product PRs route to `stage`, with reviewer routing from the protocol.
- Target design claims must be documented as design targets when not implemented in live code.

## Failure Modes

- Protocol-only enforcement can be bypassed unless Foreman owns the command path.
- A live LaunchAgent handoff can be mistaken for an active run even though no `tools/dark-factory/foreman.mjs start` has happened.
- Historical runs may lack newer loop fields or gates, so readers must distinguish legacy data from current contract.
- The live TestContract path proves holdout gating at the command/artifact layer, but it does not yet provide a full seeded stack, remote secret store, or cryptographic context redaction boundary.
- Paperclip can show a task as moving while the deterministic run is stale; loop health and sweepers exist to expose that gap.

## When This Changes, Update

- [Source Map](source-map.md) whenever a subsystem moves or a new runner/tool becomes authoritative.
- [Operating Model](operating-model.md) when the stage flow or team activation changes.
- [Factory Intake And Foreman Scheduling](intake-foreman-scheduling.md) when the live intake, scheduled handoff, or LaunchAgent boundary changes.
- [Schemas And Artifacts](schemas-artifacts.md) when persisted data models change.
- [Change Maintenance Contract](change-maintenance-contract.md) if the documentation obligation itself changes.
