# Operating Model

Backlinks: [Wiki Home](README.md), [Architecture](architecture.md)

## Purpose

Describe how Dark Factory work moves from a human request to a PR-backed outcome, and which system owns each state transition.

> **⚠️ Partially stale since the 2026-06-13 cutover (verified 2026-06-15).** The
> "live intake path" below (`scheduled intake foreman -> pi-orchestrator ->
separate factory cell`) is the **pre-cutover** model and is **stopped** — the
> launchd intake foreman is unloaded and the tmux pi-team lanes are gone. The
> team now runs as **Paperclip agents driven by the heartbeat scheduler**, and
> `pi-orchestrator` is itself a Paperclip agent. The risk-based activation
> classes and the PR-backed stage path (Planning → … → Ship → Done) still apply.
> See [Architecture](architecture.md) and [Conductor](conductor.md).

## How It Works

The live operating model combines:

- Factory intake for Development Telegram, ClickUp, and manual Paperclip Todo front doors.
- Paperclip for visible task status, comments, labels, and improvement-report approval queues.
- Foreman for deterministic run state, typed evidence, gates, readiness, No Mistakes, push, PR creation, and PR status when the run is routed through it.
- Pi/OpenClaw team protocols for activation class, specialist lanes, relay tokens, memory boundaries, research architecture, browser QA, security review, and review-to-skill.

Activation is risk-based:

- Mode 0: core-only coordination; no product PR.
- Mode 1: simple behavior change with implementation plus independent verification.
- Mode 2: full team or equivalent specialists for moderate, product, PR repair, frontend/user-flow, or risk-sensitive work.
- Mode 3: research or architecture council.
- Mode 4: isolated full factory cell for parallel or state-sensitive streams.

The **pre-cutover** intake path (now STOPPED) was Telegram/ClickUp/manual Paperclip -> Paperclip Todo -> scheduled intake foreman -> `pi-orchestrator` -> separate factory cell. **Current path:** work enters as Paperclip issues (human/`factory-intake.mjs`/routines) and the **Paperclip heartbeat** wakes the assigned agent directly; `pi-orchestrator` is now a Paperclip agent. The Foreman CLI is invoked on demand for run state/gates when a run is routed through it.

The intended PR-backed path is Planning -> Implementation -> Verification -> Browser QA when applicable -> Security Review -> No Mistakes/Foreman -> Self-Improvement/Improver review or no-op -> Ship to PR -> Human Final Review -> Done. The improver lane is mandatory before Ship to PR, Done, closed, or final disposition for every Dark Factory run.

## Key Files And Commands

- [../../pi-vs-claude-code/.pi/openclaw-teams/dark-factory-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/dark-factory-protocol.md)
- [../../pi-vs-claude-code/.pi/openclaw-teams/stage-gate-relay-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/stage-gate-relay-protocol.md)
- [../../pi-vs-claude-code/.pi/openclaw-teams/prompts/shared-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/prompts/shared-protocol.md)
- [../../paperclip-board/README.md](../../paperclip-board/README.md)
- [intake-foreman-scheduling.md](intake-foreman-scheduling.md)
- `<FORK>/dark-factory/intake/factory-foreman.mjs`
- `<FORK>/dark-factory/intake/factory-intake.mjs`
- [../foreman.mjs](../foreman.mjs)

Useful commands:

```bash
node tools/paperclip-board/create-task.mjs --title "..." --brief "..."
node tools/dark-factory/foreman.mjs advance --run RUN_DIR --stage "Verification" --summary "..."
node tools/dark-factory/foreman.mjs iterate --run RUN_DIR --loop implementation-fix-test --verdict FAIL --summary "..."
node tools/paperclip-board/factory-log.mjs event --issue OPE-123 --type stage_changed --summary "..."
```

## Source Files Inspected

- [../../pi-vs-claude-code/.pi/openclaw-teams/dark-factory-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/dark-factory-protocol.md)
- [../../pi-vs-claude-code/.pi/openclaw-teams/stage-gate-relay-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/stage-gate-relay-protocol.md)
- [../../pi-vs-claude-code/.pi/openclaw-teams/dynamic-workflows-protocol.md](../../pi-vs-claude-code/.pi/openclaw-teams/dynamic-workflows-protocol.md)
- [../../paperclip-board/README.md](../../paperclip-board/README.md)
- `<FORK>/dark-factory/intake/README.md`
- `<FORK>/dark-factory/intake/factory-foreman.mjs`
- `<FORK>/dark-factory/intake/factory-intake.mjs`
- [../README.md](../README.md)
- `/Users/samuelimini/Development/dark-factory/04-pipeline-stages.md`

## Invariants And Guardrails

- No product PR ships from Mode 0.
- Scheduled intake handoff only starts orchestration; it does not satisfy planning, evidence, security, Browser QA, No Mistakes, or PR gates.
- Planning must name allowed write scope before implementation.
- Missing required lane verdict, artifact, or Samuel waiver blocks PR handoff.
- Security is the terminal gate for code, auth, data, or deployment changes.
- Browser QA is required for UI, browser, visual, responsive, design, or user-flow work.
- Research feeds planning; it does not replace the Planning lead gate.

## Failure Modes

- A Paperclip status change without a Foreman gate can overstate readiness.
- A Todo handoff can be delivered to `pi-orchestrator` while no WorkOrder-backed run has yet been created.
- Parallel streams can bleed repo, browser, No Mistakes, or evidence state unless they are separate factory cells.
- A handoff message can be delivered while no active worker continues execution; loop-health and liveness decisions are current known improvement areas.
- A child task can be queued before its dependency or approval gate is resolved; project memory records this as a current lesson.

## When This Changes, Update

- [Paperclip Integration](paperclip-integration.md) if board statuses, labels, or task creation instructions change.
- [Factory Intake And Foreman Scheduling](intake-foreman-scheduling.md) if intake sources, schedule, handoff semantics, retry behavior, or `pi-orchestrator` routing change.
- [Pi/OpenClaw Team Protocols](pi-openclaw-team-protocols.md) if activation classes, relay tokens, or specialist lanes change.
- [Foreman CLI](foreman-cli.md) if a stage transition becomes mechanically enforced in a new command.
